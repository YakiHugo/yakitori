import { once } from "node:events"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, type Locator, type Page, test as base } from "@playwright/test"
import { stringify } from "smol-toml"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

type RenderingApp = {
  workspace: string
  imageURL: string
  imageDataURL: string
  append(prompt: string, text: string): Promise<void>
  finish(prompt: string): Promise<void>
}

const test = base.extend<{ renderingApp: RenderingApp }>({
  renderingApp: async ({ page }, use, testInfo) => {
    const environment = await createSmokeEnvironment()
    const workspace = join(environment.root, "workspace")
    const imageBytes = await readFile(join(workspace, "smoke.png"))
    const streams = new Map<
      string,
      { response: ServerResponse; completionId: string }
    >()
    let completionSequence = 0
    const errors: string[] = []
    const logs: string[] = []
    let server: ServerProcess | undefined
    page.on("pageerror", (error) => errors.push(error.message))
    const chunk = (completionId: string, text: string, finish = false) =>
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: 1,
        model: "rendering-model",
        choices: [
          {
            index: 0,
            delta: finish ? {} : { role: "assistant", content: text },
            finish_reason: finish ? "stop" : null,
          },
        ],
      })}\n\n`
    // Only the model is scripted. The built renderer, stream notifications,
    // persistence, workspace media RPC and browser image decoder are real.
    const endpoint = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/smoke.png") {
        response.writeHead(200, { "content-type": "image/png" })
        response.end(imageBytes)
        return
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "rendering-model" }] }))
        return
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404)
        response.end()
        return
      }
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (part: string) => {
        body += part
      })
      request.on("end", () => {
        const sent = JSON.parse(body) as {
          messages: { role: string; content: string }[]
        }
        const completionId = `chatcmpl-rendering-${++completionSequence}`
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.flushHeaders()
        if (
          sent.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes(
                "Generate a concise, sentence-case title",
              ),
          )
        ) {
          response.end(
            `${chunk(completionId, '{"title":"Rendering checks"}')}${chunk(completionId, "", true)}data: [DONE]\n\n`,
          )
          return
        }
        const prompt = sent.messages
          .filter((message) => message.role === "user")
          .at(-1)?.content
        if (typeof prompt !== "string") {
          errors.push("Rendering provider received no text prompt.")
          response.end(`${chunk(completionId, "", true)}data: [DONE]\n\n`)
          return
        }
        streams.set(prompt, { response, completionId })
      })
    })
    try {
      endpoint.listen(0, "127.0.0.1")
      await once(endpoint, "listening")
      const address = endpoint.address()
      if (address === null || typeof address === "string")
        throw new Error("Rendering provider TCP address is missing.")
      const origin = `http://127.0.0.1:${address.port}`
      await writeFile(
        join(environment.root, "home", "config.toml"),
        stringify({
          provider: "rendering",
          model: "rendering-model",
          model_providers: {
            rendering: {
              name: "Rendering fixture",
              api_backend: "chat_completions",
              base_url: `${origin}/v1`,
              no_key: true,
              models: [{ id: "rendering-model" }],
            },
          },
        }),
      )
      server = await spawnServerProcess({
        command: process.execPath,
        args: [resolve("src/server/start.ts")],
        cwd: environment.root,
        env: {
          ...environment.env,
          YAKITORI_PROVIDER: "rendering",
          YAKITORI_MODEL: "rendering-model",
          YAKITORI_GUI_DIR: resolve("dist/gui"),
        },
        onStdout: (line) => logs.push(line),
        onStderr: (line) => logs.push(line),
      })
      await page.goto(server.url)
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click()
      await use({
        workspace,
        imageURL: `${origin}/smoke.png`,
        imageDataURL: `data:image/png;base64,${imageBytes.toString("base64")}`,
        async append(prompt, text) {
          await expect.poll(() => streams.has(prompt)).toBe(true)
          const stream = streams.get(prompt)
          if (!stream) throw new Error("Rendering stream disappeared.")
          stream.response.write(chunk(stream.completionId, text))
        },
        async finish(prompt) {
          await expect.poll(() => streams.has(prompt)).toBe(true)
          const stream = streams.get(prompt)
          if (!stream) throw new Error("Rendering stream disappeared.")
          stream.response.end(
            `${chunk(stream.completionId, "", true)}data: [DONE]\n\n`,
          )
          streams.delete(prompt)
          await expect(
            page.getByRole("button", { name: "Interrupt", exact: true }),
          ).toHaveCount(0)
        },
      })
      expect(errors).toEqual([])
    } finally {
      try {
        endpoint.closeAllConnections()
        if (endpoint.listening)
          await new Promise<void>((resolve, reject) =>
            endpoint.close((error) => (error ? reject(error) : resolve())),
          )
        await testInfo.attach("rendering-server.log", {
          body: logs.join("\n"),
          contentType: "text/plain",
        })
      } finally {
        const timer = setTimeout(() => void server?.forceStop(), 5_000)
        try {
          await server?.stop()
        } finally {
          clearTimeout(timer)
          await environment.cleanup()
        }
      }
    }
  },
})

async function send(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "Message the Mate" }).fill(prompt)
  await page.getByRole("button", { name: "Send", exact: true }).click()
}

async function expectLoadedPNG(image: Locator) {
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((node: HTMLImageElement) => ({
        width: node.naturalWidth,
        height: node.naturalHeight,
        complete: node.complete,
      })),
    )
    .toEqual({ width: 16, height: 16, complete: true })
}

async function expectMermaidDiagram(image: Locator, labels: string[]) {
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml[;,]/)
  await expect
    .poll(() =>
      image.evaluate(
        (node: HTMLImageElement) =>
          node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
      ),
    )
    .toBe(true)
  const svg = await image.evaluate(async (node: HTMLImageElement) =>
    (await fetch(node.src)).text(),
  )
  expect(svg).toContain("<svg")
  for (const label of labels) expect(svg).toContain(label)
}

test("Markdown images load local, inline and HTTP sources during streaming and after reload", async ({
  page,
  renderingApp,
}) => {
  const prompt = "Show the image rendering fixtures."
  await copyFile(
    join(renderingApp.workspace, "smoke.png"),
    join(renderingApp.workspace, "space image.png"),
  )
  await send(page, prompt)
  await renderingApp.append(prompt, "![Streaming workspace](smoke")
  const current = page.getByRole("region", {
    name: "Current response",
    exact: true,
  })
  await expect(current).toContainText("![Streaming workspace](smoke")
  await expect(current.getByRole("img")).toHaveCount(0)
  await renderingApp.append(
    prompt,
    `.png)\n\n${[
      `![Absolute workspace](${join(renderingApp.workspace, "smoke.png")})`,
      `![File URL](${pathToFileURL(join(renderingApp.workspace, "smoke.png")).href})`,
      "![Encoded workspace](space%20image.png)",
      `![Inline image](${renderingApp.imageDataURL})`,
      `![HTTP image](${renderingApp.imageURL})`,
    ].join("\n\n")}`,
  )
  await expectLoadedPNG(
    current.getByRole("img", { name: "Streaming workspace", exact: true }),
  )
  await renderingApp.finish(prompt)
  const verify = async () => {
    const response = page.getByRole("region", { name: "Response", exact: true })
    for (const name of [
      "Streaming workspace",
      "Absolute workspace",
      "File URL",
      "Encoded workspace",
      "Inline image",
      "HTTP image",
    ])
      await expectLoadedPNG(response.getByRole("img", { name, exact: true }))
  }
  await verify()
  await page.reload()
  await verify()
})

test("Markdown file previews resolve images relative to the document directory", async ({
  page,
  renderingApp,
}) => {
  await mkdir(join(renderingApp.workspace, "docs", "assets"), {
    recursive: true,
  })
  await copyFile(
    join(renderingApp.workspace, "smoke.png"),
    join(renderingApp.workspace, "docs", "assets", "diagram.png"),
  )
  await writeFile(
    join(renderingApp.workspace, "docs", "README.md"),
    "# Rendering guide\n\n![Document image](assets/diagram.png)\n\n![Workspace parent](../smoke.png)\n\n![Missing document image](assets/missing.png)\n",
  )
  const prompt = "Open the rendering guide."
  await send(page, prompt)
  await renderingApp.append(prompt, "[Rendering guide](docs/README.md)")
  await renderingApp.finish(prompt)
  await page
    .getByRole("region", { name: "Response", exact: true })
    .getByRole("link", { name: "Rendering guide", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Rendering guide", exact: true }),
  ).toBeVisible()
  await expectLoadedPNG(
    page.getByRole("img", { name: "Document image", exact: true }),
  )
  await expectLoadedPNG(
    page.getByRole("img", { name: "Workspace parent", exact: true }),
  )
  await expect(
    page.getByText("Image unavailable · Missing document image", {
      exact: true,
    }),
  ).toBeVisible()
})

test("Mermaid waits for completed output, preserves invalid source and recovers on later diagrams", async ({
  page,
  renderingApp,
}) => {
  const prompt = "Stream a Mermaid diagram."
  await send(page, prompt)
  await renderingApp.append(prompt, "```mermaid\ngraph TD\n  A[Start] -->")
  const current = page.getByRole("region", {
    name: "Current response",
    exact: true,
  })
  await expect(current.locator("pre")).toContainText("A[Start] -->")
  await expect(
    current.getByRole("img", { name: "Mermaid diagram", exact: true }),
  ).toHaveCount(0)
  await renderingApp.append(prompt, " B[Finish]\n```\n\nDiagram complete.")
  await expect(current).toContainText("Diagram complete.")
  await expect(current.locator("pre")).toContainText("B[Finish]")
  await expect(
    current.getByRole("img", { name: "Mermaid diagram", exact: true }),
  ).toHaveCount(0)
  await renderingApp.finish(prompt)
  const responses = page.getByRole("region", { name: "Response", exact: true })
  await expectMermaidDiagram(
    responses
      .first()
      .getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Start", "Finish"],
  )
  await responses
    .first()
    .getByRole("button", { name: "Show Mermaid source", exact: true })
    .click()
  await expect(responses.first().locator("pre")).toContainText(
    "A[Start] --> B[Finish]",
  )
  await responses
    .first()
    .getByRole("button", { name: "Show Mermaid diagram", exact: true })
    .click()
  await expectMermaidDiagram(
    responses
      .first()
      .getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Start", "Finish"],
  )

  const invalid = "Show an invalid Mermaid diagram."
  await send(page, invalid)
  await renderingApp.append(invalid, "```mermaid\ngraph TD\n  A[Unclosed\n```")
  await renderingApp.finish(invalid)
  await expect(responses.nth(1).getByRole("status")).toContainText(
    "Could not render Mermaid diagram.",
  )
  await expect(responses.nth(1).locator("pre")).toContainText("A[Unclosed")
  await expect(
    responses.nth(1).getByRole("img", { name: "Mermaid diagram", exact: true }),
  ).toHaveCount(0)

  const recovered = "Show another valid Mermaid diagram."
  await send(page, recovered)
  // CommonMark accepts an unclosed fence at end of a completed response.
  await renderingApp.append(
    recovered,
    "```mermaid\ngraph LR\n  C[Recovered] --> D[Ready]",
  )
  await renderingApp.finish(recovered)
  await expectMermaidDiagram(
    responses.nth(2).getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Recovered", "Ready"],
  )
  await page.reload()
  await expectMermaidDiagram(
    responses
      .first()
      .getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Start", "Finish"],
  )
  await expect(responses.nth(1).locator("pre")).toContainText("A[Unclosed")
  await expectMermaidDiagram(
    responses.nth(2).getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Recovered", "Ready"],
  )
})

test("large Mermaid previews expose every edge at actual size and reset when reopened", async ({
  page,
  renderingApp,
}) => {
  await page.setViewportSize({ width: 1_000, height: 700 })
  // Independent LR lanes make a real graph larger than the viewer in both
  // directions, rather than a tiny diagram that cannot expose zoom clipping.
  const lanes = Array.from({ length: 9 }, (_, lane) =>
    Array.from(
      { length: 9 },
      (_, stage) => `L${lane}S${stage}["Lane ${lane + 1} stage ${stage + 1}"]`,
    ).join(" --> "),
  )
  const prompt = "Show a large Mermaid layout."
  await send(page, prompt)
  await renderingApp.append(
    prompt,
    `\`\`\`mermaid\nflowchart LR\n${lanes.join("\n")}\n\`\`\``,
  )
  await renderingApp.finish(prompt)
  const response = page.getByRole("region", { name: "Response", exact: true })
  await expectMermaidDiagram(
    response.getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Lane 1 stage 1", "Lane 9 stage 9"],
  )
  const expand = response.getByRole("button", {
    name: "Expand Mermaid diagram",
    exact: true,
  })
  await expand.click()
  const preview = page.getByRole("dialog", {
    name: "Preview Mermaid diagram",
    exact: true,
  })
  const image = preview.getByRole("img", {
    name: "Mermaid diagram",
    exact: true,
  })
  const geometry = () =>
    image.evaluate((node: HTMLImageElement) => {
      const viewport = node.parentElement
      if (!viewport) throw new Error("Diagram scroll viewport is missing.")
      const image = node.getBoundingClientRect()
      const box = viewport.getBoundingClientRect()
      const left = box.left + viewport.clientLeft
      const top = box.top + viewport.clientTop
      const right = left + viewport.clientWidth
      const bottom = top + viewport.clientHeight
      return {
        width: image.width,
        height: image.height,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        fits:
          image.left >= left - 1 &&
          image.top >= top - 1 &&
          image.right <= right + 1 &&
          image.bottom <= bottom + 1,
        startReachable:
          image.left >= left - 1 &&
          image.left < right &&
          image.top >= top - 1 &&
          image.top < bottom,
        endReachable:
          image.right <= right + 1 &&
          image.right > left &&
          image.bottom <= bottom + 1 &&
          image.bottom > top,
        actualSize:
          Math.abs(image.width - node.naturalWidth) < 1 &&
          Math.abs(image.height - node.naturalHeight) < 1,
      }
    })
  await expect(preview).toBeVisible()
  await expect(
    preview.getByRole("button", { name: "Actual size", exact: true }),
  ).toBeEnabled()
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  const fittedWidth = (await geometry()).width
  await preview.getByRole("button", { name: "Zoom in", exact: true }).click()
  await expect
    .poll(async () => (await geometry()).width)
    .toBeGreaterThan(fittedWidth)
  await preview
    .getByRole("button", { name: "Actual size", exact: true })
    .click()
  await expect.poll(async () => (await geometry()).actualSize).toBe(true)
  const actual = await geometry()
  expect(actual.width).toBeGreaterThan(actual.viewportWidth)
  expect(actual.height).toBeGreaterThan(actual.viewportHeight)
  await image.evaluate((node) => node.parentElement?.scrollTo(0, 0))
  await expect.poll(async () => (await geometry()).startReachable).toBe(true)
  await image.evaluate((node) => {
    const viewport = node.parentElement
    viewport?.scrollTo(viewport.scrollWidth, viewport.scrollHeight)
  })
  await expect.poll(async () => (await geometry()).endReachable).toBe(true)
  await preview.getByRole("button", { name: "Reset zoom", exact: true }).click()
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  await expect
    .poll(async () => Math.abs((await geometry()).width - fittedWidth))
    .toBeLessThan(1)
  await preview
    .getByRole("button", { name: "Actual size", exact: true })
    .click()
  await expect.poll(async () => (await geometry()).actualSize).toBe(true)
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)
  await expand.click()
  await expect(preview).toBeVisible()
  await expect(
    preview.getByRole("button", { name: "Actual size", exact: true }),
  ).toBeEnabled()
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  await expect
    .poll(async () => Math.abs((await geometry()).width - fittedWidth))
    .toBeLessThan(1)
  await preview
    .getByRole("button", { name: "Close preview", exact: true })
    .click()
  await expect(preview).toHaveCount(0)
})
