import { once } from "node:events"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { test as base, expect, type Locator } from "@playwright/test"
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
  send(prompt: string): Promise<void>
  append(prompt: string, text: string): Promise<void>
  think(prompt: string, text: string): Promise<void>
  callTool(
    prompt: string,
    name: string,
    input: Record<string, unknown>,
    count?: number,
  ): Promise<void>
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
    let expectedPrompt: string | undefined
    const errors: string[] = []
    const logs: string[] = []
    let server: ServerProcess | undefined
    page.on("pageerror", (error) => errors.push(error.message))
    const chunk = (
      completionId: string,
      text: string,
      finish = false,
      field = "content",
    ) =>
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: 1,
        model: "rendering-model",
        choices: [
          {
            index: 0,
            delta: finish ? {} : { role: "assistant", [field]: text },
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
        const userMessages = sent.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
        logs.push(
          `Rendering provider user messages: ${JSON.stringify(userMessages)}`,
        )
        // The runtime appends environment context as another user message.
        // Match the explicit input for this turn without assuming it is last.
        if (
          expectedPrompt === undefined ||
          !userMessages.includes(expectedPrompt)
        ) {
          errors.push(
            "Rendering provider did not receive the expected turn input.",
          )
          response.end(`${chunk(completionId, "", true)}data: [DONE]\n\n`)
          return
        }
        streams.set(expectedPrompt, { response, completionId })
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
              authentication: "none",
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
        async send(prompt) {
          expectedPrompt = prompt
          await page
            .getByRole("textbox", { name: "Message the Mate" })
            .fill(prompt)
          await page.getByRole("button", { name: "Send", exact: true }).click()
        },
        async append(prompt, text) {
          await expect
            .poll(() => ({ received: streams.has(prompt), errors }))
            .toEqual({ received: true, errors: [] })
          const stream = streams.get(prompt)
          if (!stream) throw new Error("Rendering stream disappeared.")
          stream.response.write(chunk(stream.completionId, text))
        },
        async think(prompt, text) {
          await expect.poll(() => streams.has(prompt)).toBe(true)
          const stream = streams.get(prompt)
          if (!stream) throw new Error("Rendering stream disappeared.")
          stream.response.write(
            chunk(stream.completionId, text, false, "reasoning_content"),
          )
        },
        async callTool(prompt, name, input, count = 1) {
          await expect.poll(() => streams.has(prompt)).toBe(true)
          const stream = streams.get(prompt)
          if (!stream) throw new Error("Rendering stream disappeared.")
          streams.delete(prompt)
          stream.response.end(
            `data: ${JSON.stringify({
              id: stream.completionId,
              object: "chat.completion.chunk",
              created: 1,
              model: "rendering-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: Array.from({ length: count }, (_, index) => ({
                      index,
                      id: `call-${stream.completionId}-${index}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(input) },
                    })),
                  },
                  finish_reason: "tool_calls",
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
          )
        },
        async finish(prompt) {
          await expect
            .poll(() => ({ received: streams.has(prompt), errors }))
            .toEqual({ received: true, errors: [] })
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

async function expectMermaidDiagram(
  image: Locator,
  labels: string[],
  expectedNodeCount?: number,
) {
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
  const nodeLabels = await image.evaluate(async (node: HTMLImageElement) => {
    const svg = new DOMParser().parseFromString(
      await (await fetch(node.src)).text(),
      "image/svg+xml",
    )
    if (
      svg.documentElement.localName !== "svg" ||
      svg.querySelector("parsererror")
    )
      throw new Error("Mermaid image did not contain a valid SVG document.")
    // Mermaid may split a visible label across nested tspans. Assert decoded
    // node text rather than a substring of the serialized XML markup.
    return Array.from(svg.querySelectorAll(".node"), (element) =>
      (element.querySelector(".label")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    )
  })
  for (const label of labels) expect(nodeLabels).toContain(label)
  if (expectedNodeCount !== undefined)
    expect(nodeLabels).toHaveLength(expectedNodeCount)
}

test("Escape dismisses the model menu before interrupting the focused conversation", async ({
  page,
  renderingApp,
}) => {
  const prompt = "Keep this response streaming until interrupted."
  await renderingApp.send(prompt)
  await renderingApp.append(prompt, "Output before interruption.")
  const response = page.getByRole("region", {
    name: "Current response",
    exact: true,
  })
  await expect(response).toContainText("Output before interruption.")
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  await composer.fill("Keep this unsent draft.")

  // Synthetic IME signals exercise the browser event route, not an OS input
  // method. The final ordinary Escape below is actual browser keyboard input.
  await composer.dispatchEvent("compositionstart")
  await composer.press("Escape")
  await composer.dispatchEvent("compositionend")
  for (const options of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
  ]) {
    await composer.dispatchEvent("keydown", { key: "Escape", ...options })
  }
  await renderingApp.append(prompt, " Still running after ignored keys.")
  await expect(response).toContainText("Still running after ignored keys.")

  const models = page.getByRole("button", { name: "Select model and effort" })
  await models.click()
  await expect(models).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(models).toHaveAttribute("aria-expanded", "false")
  await renderingApp.append(prompt, " Still running after menu dismissal.")
  await expect(response).toContainText("Still running after menu dismissal.")

  await composer.focus()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: /^(Interrupt|Stopping)$/ }),
  ).toHaveCount(0)
  await expect(composer).toHaveText("Keep this unsent draft.")
  const interrupted = page.getByRole("region", {
    name: "Response",
    exact: true,
  })
  await expect(interrupted).toContainText("Turn interrupted")
  // Interrupted output is retained as activity, not promoted to a final answer.
  await interrupted.getByRole("button", { name: /^Worked for/ }).click()
  await expect(interrupted).toContainText(
    "Output before interruption. Still running after ignored keys. Still running after menu dismissal.",
  )
  // Select through the editor command: fill("") changes the DOM selection,
  // which can reach Delete before ProseMirror has observed selectionchange.
  await composer.press("ControlOrMeta+A")
  await composer.press("Backspace")
  await expect(composer).toHaveText("")
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible()
})

test("user messages expose only copy and edit actions", async ({
  page,
  context,
  renderingApp,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const prompt = "Keep only the message actions."
  await renderingApp.send(prompt)
  await renderingApp.append(prompt, "Message actions checked.")
  await renderingApp.finish(prompt)
  const message = page
    .locator(".group")
    .filter({ has: page.getByText(prompt, { exact: true }) })
  await message.hover()
  await expect(message.getByRole("button")).toHaveCount(2)
  await message
    .getByRole("button", { name: "Copy message", exact: true })
    .click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt)
  await message
    .getByRole("button", { name: "Edit & resubmit", exact: true })
    .click()
  await expect(
    message.getByRole("textbox", { name: "Edit message", exact: true }),
  ).toHaveText(prompt)
  await message.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(message.getByRole("button")).toHaveCount(2)
  await message.hover()
  await message.screenshot({
    path: testInfo.outputPath("user-message-actions.png"),
  })
})

test("conversation scrolls at the page edge while the project overview stays on demand", async ({
  page,
  renderingApp,
}, testInfo) => {
  const prompt = "Check the conversation scroll layout."
  await renderingApp.send(prompt)
  await renderingApp.append(
    prompt,
    Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`).join(
      "\n\n",
    ),
  )
  await renderingApp.finish(prompt)
  const viewport = page.locator(".conversation-transcript-viewport")
  const content = page.locator(".conversation-content")
  const composer = page.locator(".conversation-composer")
  const overview = page.getByRole("dialog", { name: "Project overview" })
  await expect(overview).toHaveCount(0)
  for (const width of [1480, 1180, 1100]) {
    await page.setViewportSize({ width, height: 960 })
    await expect
      .poll(async () => {
        const box = await viewport.boundingBox()
        return box ? Math.abs(box.x + box.width - width) : Infinity
      })
      .toBeLessThan(1)
    const contentBox = await content.boundingBox()
    const composerBox = await composer.boundingBox()
    if (!contentBox || !composerBox) throw new Error("Conversation is missing.")
    expect(contentBox.width).toBeLessThanOrEqual(768)
    expect(Math.abs(contentBox.x - composerBox.x)).toBeLessThan(1)
    expect(Math.abs(contentBox.width - composerBox.width)).toBeLessThan(1)
    await expect(overview).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width)
  }
  await page.setViewportSize({ width: 1480, height: 960 })
  const transcriptBeforeOverview = await viewport.boundingBox()
  await page
    .getByRole("button", { name: "Show project overview", exact: true })
    .click()
  await expect(overview).toBeVisible()
  await overview.screenshot({
    path: testInfo.outputPath("project-overview.png"),
  })
  expect(await viewport.boundingBox()).toEqual(transcriptBeforeOverview)
  await viewport.evaluate((node) => {
    node.scrollTop = 0
  })
  await page.mouse.move(1440, 400)
  await page.mouse.wheel(0, 400)
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0)
  await page.getByRole("button", { name: "Changes", exact: true }).click()
  await expect(overview).toHaveCount(0)
  const workspace = page.getByRole("complementary", {
    name: "Workspace",
    exact: true,
  })
  await expect
    .poll(async () => {
      const transcriptBox = await viewport.boundingBox()
      const workspaceBox = await workspace.boundingBox()
      return transcriptBox && workspaceBox
        ? Math.abs(transcriptBox.x + transcriptBox.width - workspaceBox.x)
        : Infinity
    })
    .toBeLessThan(1)
  await page.getByRole("button", { name: "Expand workspace" }).click()
  await expect(viewport).toBeHidden()
  await page.getByRole("button", { name: "Restore workspace size" }).click()
  await expect(viewport).toBeVisible()
  await page.getByRole("button", { name: "Hide workspace" }).click()
  await page.getByRole("textbox", { name: "Message the Mate" }).fill("/goal")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const goalEditor = page.getByRole("complementary", { name: "Goal editor" })
  await expect(goalEditor).toBeVisible()
  const goalBox = await goalEditor.boundingBox()
  const transcriptBox = await viewport.boundingBox()
  if (!goalBox || !transcriptBox) throw new Error("Session panels are missing.")
  await expect(overview).toHaveCount(0)
  expect(
    Math.abs(transcriptBox.x + transcriptBox.width - goalBox.x),
  ).toBeLessThan(1)
  await page.getByRole("button", { name: "Close goal editor" }).click()
  await viewport.hover()
  await page.screenshot({
    path: testInfo.outputPath("conversation-scroll-layout.png"),
  })
})

test("new session composer stays centered through creation and docks after the first input", async ({
  page,
  renderingApp,
}) => {
  const project = page.getByRole("combobox", { name: "New session project" })
  await expect(project).toBeDisabled()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const recording = await page
    .getByRole("button", { name: "New session", exact: true })
    .evaluateHandle((button: HTMLButtonElement) => {
      const recording = {
        frames: [] as { top: number; centerOffset: number }[],
        stopped: false,
      }
      const sample = () => {
        if (recording.stopped) return
        const composer = document.querySelector("[data-composer-surface]")
        const dock = composer?.closest(".conversation-dock")
        const surface = composer?.closest(".conversation-surface")
        if (!composer || !dock || !surface)
          throw new Error("Conversation layout disappeared during creation.")
        const dockBox = dock.getBoundingClientRect()
        const surfaceBox = surface.getBoundingClientRect()
        recording.frames.push({
          top: composer.getBoundingClientRect().top,
          centerOffset:
            dockBox.top +
            dockBox.height / 2 -
            (surfaceBox.top + surfaceBox.height / 2),
        })
        requestAnimationFrame(sample)
      }
      // Start before the click's first paint, including any intermediate
      // create response or replay renders rather than only the settled layout.
      button.click()
      requestAnimationFrame(sample)
      return recording
    })
  const prompt = "Check the composer layout."
  await page.getByRole("textbox", { name: "Message the Mate" }).fill(prompt)
  await expect(project).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled()
  const frames = await recording.evaluate(async (recording) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    recording.stopped = true
    return recording.frames
  })
  await recording.dispose()
  expect(frames.length).toBeGreaterThan(1)
  for (const frame of frames)
    expect(Math.abs(frame.centerOffset)).toBeLessThan(1)
  const tops = frames.map((frame) => frame.top)
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1)

  await renderingApp.send(prompt)
  await renderingApp.append(prompt, "Composer layout checked.")
  const dock = page.locator(".conversation-dock")
  await expect
    .poll(() =>
      dock.evaluate((node) => {
        const surface = node.closest(".conversation-surface")
        if (!surface) throw new Error("Conversation surface is missing.")
        return Math.abs(
          node.getBoundingClientRect().bottom -
            surface.getBoundingClientRect().bottom,
        )
      }),
    )
    .toBeLessThan(1)
  const composer = await page.locator("[data-composer-surface]").boundingBox()
  expect(composer?.y).toBeGreaterThan(Math.max(...tops))
  await expect(project).toHaveCount(0)
  await renderingApp.finish(prompt)
})

test("selected text opens a source comment and keeps the composer draft across new sessions", async ({
  page,
  renderingApp,
}, testInfo) => {
  const prompt = "Explain the excerpt focus order."
  const explanation = "Review this explanation before adding it to the draft."
  await renderingApp.send(prompt)
  await renderingApp.append(prompt, explanation)
  await renderingApp.finish(prompt)
  const response = page
    .getByRole("region", { name: "Response", exact: true })
    .getByText(explanation, { exact: true })
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  await composer.fill("Keep my unfinished question")
  for (const [index, confirmation] of ["Save comment", "Enter"].entries()) {
    await response.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })
    await page.getByRole("button", { name: "Add to chat" }).click()
    const annotations = page
      .locator("[data-composer-surface]")
      .getByRole("button", {
        name: index === 0 ? "1 annotation" : "2 annotations",
        exact: true,
      })
    const comment = page.getByRole("textbox", {
      name: "Excerpt comment (optional)",
    })
    await expect(comment).toBeFocused()
    await expect(composer).toHaveText("Keep my unfinished question")
    const sourceBounds = await response.boundingBox()
    const commentBounds = await page
      .getByRole("dialog", { name: "Excerpt comment" })
      .boundingBox()
    expect(sourceBounds).not.toBeNull()
    expect(commentBounds).not.toBeNull()
    if (sourceBounds && commentBounds)
      expect(
        Math.min(
          Math.abs(commentBounds.y + commentBounds.height - sourceBounds.y),
          Math.abs(commentBounds.y - sourceBounds.y - sourceBounds.height),
        ),
      ).toBeLessThan(40)
    await comment.fill(`Confirmed with ${confirmation}`)
    if (index === 0)
      await page.screenshot({
        path: testInfo.outputPath("annotation-editor.png"),
        animations: "disabled",
      })
    if (confirmation === "Enter") await comment.press("Enter")
    else
      await page
        .getByRole("button", { name: "Save comment", exact: true })
        .click()
    await expect(comment).toHaveCount(0)
    await expect(composer).toBeFocused()
    await expect(annotations).toBeVisible()
    await annotations.click()
    await expect(
      page.getByRole("dialog", { name: "Annotations", exact: true }),
    ).toContainText(`Confirmed with ${confirmation}`)
    await page.keyboard.press("Escape")
    await composer.focus()
  }
  const firstMarker = await page
    .getByRole("button", { name: "Open excerpt 1 in main conversation" })
    .boundingBox()
  const secondMarker = await page
    .getByRole("button", { name: "Open excerpt 2 in main conversation" })
    .boundingBox()
  expect(firstMarker).not.toBeNull()
  expect(secondMarker).not.toBeNull()
  if (firstMarker && secondMarker)
    expect(firstMarker.x + firstMarker.width).toBeLessThanOrEqual(
      secondMarker.x,
    )
  const original = page.locator(
    '.sidebar-session [data-sidebar-drag="session"][aria-current="true"]',
  )
  const originalId = await original.getAttribute("data-drag-id")
  if (!originalId) throw new Error("Missing original session")
  await page.getByRole("button", { name: "New session", exact: true }).click()
  await expect(composer).toHaveText("")
  await expect(
    page.locator("[data-composer-surface] .context-excerpt-pill"),
  ).toHaveCount(0)
  await composer.fill("A separate new draft")
  await page
    .locator(`[data-sidebar-drag="session"][data-drag-id="${originalId}"]`)
    .click()
  await expect(composer).toHaveText("Keep my unfinished question")
  await expect(
    page.locator("[data-composer-surface] .context-excerpt-pill"),
  ).toHaveCount(1)
  await page
    .locator("[data-composer-surface]")
    .getByRole("button", { name: "2 annotations", exact: true })
    .click()
  const details = page.getByRole("dialog", { name: "Annotations", exact: true })
  await expect(details).toContainText("Confirmed with Save comment")
  await expect(details).toContainText("Confirmed with Enter")
  await page.screenshot({
    path: testInfo.outputPath("annotation-summary.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 600, height: 700 })
  await page
    .locator("[data-composer-surface]")
    .getByRole("button", { name: "2 annotations", exact: true })
    .click()
  const bounds = await details.boundingBox()
  expect(bounds).not.toBeNull()
  if (bounds) {
    expect(bounds.x).toBeGreaterThanOrEqual(8)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(592)
    expect(bounds.y).toBeGreaterThanOrEqual(8)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(692)
  }
  await page.screenshot({
    path: testInfo.outputPath("annotation-summary-narrow.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await page
    .getByRole("button", { name: "Open excerpt 2 in main conversation" })
    .click()
  const narrowEditor = page.getByRole("dialog", {
    name: "Excerpt comment",
    exact: true,
  })
  const editorBounds = await narrowEditor.boundingBox()
  expect(editorBounds).not.toBeNull()
  if (editorBounds) {
    expect(editorBounds.x).toBeGreaterThanOrEqual(8)
    expect(editorBounds.x + editorBounds.width).toBeLessThanOrEqual(592)
    expect(editorBounds.y).toBeGreaterThanOrEqual(8)
    expect(editorBounds.y + editorBounds.height).toBeLessThanOrEqual(692)
  }
  await page.screenshot({
    path: testInfo.outputPath("annotation-editor-dark-narrow.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  await page
    .locator("[data-composer-surface]")
    .getByRole("button", { name: "2 annotations", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Remove excerpt 1", exact: true })
    .click()
  await expect(details.getByRole("listitem")).toHaveCount(1)
  await expect(details).toContainText("Confirmed with Enter")
  await expect(details).not.toContainText("Confirmed with Save comment")
  await expect(
    page
      .locator("[data-composer-surface]")
      .getByRole("button", { name: "1 annotation", exact: true }),
  ).toBeVisible()
})

test("Markdown images load local, inline and HTTP sources during streaming and after reload", async ({
  page,
  renderingApp,
}) => {
  const prompt = "Show the image rendering fixtures."
  await copyFile(
    join(renderingApp.workspace, "smoke.png"),
    join(renderingApp.workspace, "space image.png"),
  )
  await renderingApp.send(prompt)
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
  await renderingApp.send(prompt)
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
  await renderingApp.send(prompt)
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
  await renderingApp.send(invalid)
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
  await renderingApp.send(recovered)
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
    ["Recovered", "Ready"],
  )
  await expect(responses).toHaveCount(1)
  await page.keyboard.press("ControlOrMeta+f")
  await page
    .getByRole("searchbox", { name: "Find in conversation" })
    .fill(prompt)
  await expect(page.locator("[data-find-current]")).toContainText(prompt)
  await page.getByRole("button", { name: "Close find", exact: true }).click()
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
  await renderingApp.send(prompt)
  await renderingApp.append(
    prompt,
    `\`\`\`mermaid\nflowchart LR\n${lanes.join("\n")}\n\`\`\``,
  )
  await renderingApp.finish(prompt)
  const response = page.getByRole("region", { name: "Response", exact: true })
  await expectMermaidDiagram(
    response.getByRole("img", { name: "Mermaid diagram", exact: true }),
    ["Lane 1 stage 1", "Lane 9 stage 9"],
    81,
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
  const closePreview = preview.getByRole("button", {
    name: "Close preview",
    exact: true,
  })
  await expect(closePreview).toBeFocused()
  await page
    .getByRole("textbox", { name: "Message the Mate", includeHidden: true })
    .evaluate((composer) => composer.focus())
  await expect(closePreview).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  // Chromium can move focus to browser chrome (reported as body). Background
  // page controls must remain inert throughout keyboard navigation.
  await expect
    .poll(() =>
      preview.evaluate(
        (dialog) =>
          document.activeElement === document.body ||
          dialog.contains(document.activeElement),
      ),
    )
    .toBe(true)
  for (let index = 0; index < 7; index += 1) {
    await page.keyboard.press("Tab")
    await expect
      .poll(() =>
        preview.evaluate(
          (dialog) =>
            document.activeElement === document.body ||
            dialog.contains(document.activeElement),
        ),
      )
      .toBe(true)
  }
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
  await expect(expand).toBeFocused()
  await expand.click()
  await expect(preview).toBeVisible()
  await expect(
    preview.getByRole("button", { name: "Actual size", exact: true }),
  ).toBeEnabled()
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  await expect
    .poll(async () => Math.abs((await geometry()).width - fittedWidth))
    .toBeLessThan(1)
  await page.setViewportSize({ width: 700, height: 520 })
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  await expect
    .poll(async () => (await geometry()).width)
    .toBeLessThan(fittedWidth)
  const narrowFittedWidth = (await geometry()).width
  await preview
    .getByRole("button", { name: "Actual size", exact: true })
    .click()
  await expect.poll(async () => (await geometry()).actualSize).toBe(true)
  const zoomBeforeResize = await preview
    .getByRole("button", { name: "Reset zoom", exact: true })
    .innerText()
  await page.setViewportSize({ width: 850, height: 600 })
  // Wait for the resized fit measurement before checking 1:1 pixels.
  await expect(
    preview.getByRole("button", { name: "Reset zoom", exact: true }),
  ).not.toHaveText(zoomBeforeResize)
  await expect.poll(async () => (await geometry()).actualSize).toBe(true)
  await preview.getByRole("button", { name: "Reset zoom", exact: true }).click()
  await expect.poll(async () => (await geometry()).fits).toBe(true)
  await expect
    .poll(async () => (await geometry()).width)
    .toBeGreaterThan(narrowFittedWidth)
  await expect
    .poll(async () => (await geometry()).width)
    .toBeLessThan(fittedWidth)
  await preview
    .getByRole("button", { name: "Close preview", exact: true })
    .click()
  await expect(preview).toHaveCount(0)
})

test("tool rows expose file actions without opening output and keep narrow layouts readable", async ({
  page,
  context,
  renderingApp,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const path = "src/nested-directory/another-directory/long-source-file-name.ts"
  await mkdir(
    join(renderingApp.workspace, "src/nested-directory/another-directory"),
    { recursive: true },
  )
  await writeFile(
    join(renderingApp.workspace, path),
    Array.from({ length: 30 }, (_, index) => `Source line ${index + 1}`).join(
      "\n",
    ),
  )
  const prompt = "Read the source file."
  await renderingApp.send(prompt)
  await renderingApp.callTool(prompt, "read_file", {
    path,
    offset: 12,
    limit: 3,
  })
  await renderingApp.append(prompt, "The source file has been checked.")
  await renderingApp.finish(prompt)
  const response = page.getByRole("region", { name: "Response", exact: true })
  await response.getByRole("button", { name: /^Worked for/ }).click()
  const row = response.locator(".tool-cell")
  await expect(row).toHaveCount(1)
  const trigger = row.getByRole("button", { name: /Read src\// })
  const copy = row.getByRole("button", { name: "Copy path", exact: true })
  await copy.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await expect(copy).toBeVisible()
  await expect(copy).toHaveCSS("opacity", "1")
  await copy.click()
  await expect(row.getByText("Copied", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${renderingApp.workspace}/${path}:12`,
  )
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.focus()
  await page.keyboard.press("Enter")
  await expect(row.getByText(/Source line 12/)).toBeVisible()
  await trigger.press("Enter")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await page.setViewportSize({ width: 600, height: 700 })
  await expect(copy).toBeVisible()
  const overflow = await row.evaluate(
    (node) => node.scrollWidth > node.clientWidth,
  )
  expect(overflow).toBe(false)
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath("tool-row-narrow.png"),
    animations: "disabled",
  })
})

test("failed tools show their full error on narrow screens and command output stays bounded", async ({
  page,
  renderingApp,
}, testInfo) => {
  const prompt = "Check a missing file."
  await renderingApp.send(prompt)
  await renderingApp.callTool(prompt, "read_file", { path: "missing-file.ts" })
  await renderingApp.append(prompt, "The requested file is missing.")
  await renderingApp.finish(prompt)
  await page.setViewportSize({ width: 600, height: 700 })
  const response = page
    .getByRole("region", { name: "Response", exact: true })
    .first()
  await response.getByRole("button", { name: /^Worked for/ }).click()
  const failed = response.locator('.tool-cell[data-status="failed"]')
  await expect(failed.getByText("Failed", { exact: true })).toBeVisible()
  await expect(
    failed.getByRole("button", { name: /Read missing-file.ts/ }),
  ).toHaveAttribute("aria-expanded", "true")
  await expect(failed.locator(".tool-detail-surface")).toContainText(
    /not found|ENOENT|does not exist/i,
  )
  await expect(failed.locator(".tool-detail-surface")).toHaveCSS(
    "border-top-width",
    "0px",
  )
  expect(
    await failed.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(false)
  await page.screenshot({
    path: testInfo.outputPath("tool-error-narrow.png"),
    animations: "disabled",
  })

  const commandPrompt = "Print the output fixture."
  await renderingApp.send(commandPrompt)
  await renderingApp.callTool(commandPrompt, "exec_command", {
    cmd: "printf 'output line\\n%.0s' {1..150}",
  })
  await page.getByRole("button", { name: "Allow", exact: true }).click()
  await renderingApp.append(commandPrompt, "The command output is ready.")
  await renderingApp.finish(commandPrompt)
  const commandResponse = page
    .getByRole("region", { name: "Response", exact: true })
    .last()
  await commandResponse.getByRole("button", { name: /^Worked for/ }).click()
  const command = commandResponse.locator(".tool-cell")
  await command.getByRole("button", { name: /Run/ }).click()
  const output = command.locator(".tool-output")
  await expect(output).toContainText("output line")
  const geometry = await output.evaluate((node) => ({
    height: node.clientHeight,
    scrollable: node.scrollHeight > node.clientHeight,
    lines: (node.textContent?.match(/output line\n/g) ?? []).length,
  }))
  expect(geometry.height).toBeLessThan(700)
  expect(geometry.scrollable).toBe(true)
  expect(geometry.lines).toBe(150)
  const original = await output.elementHandle()
  if (!original) throw new Error("Command output is missing.")
  await output.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  const scrollTop = await output.evaluate((node) => node.scrollTop)
  const history = commandResponse.getByRole("button", { name: /^Worked for/ })
  await history.click()
  await expect(output).toBeHidden()
  await history.click()
  expect(await original.evaluate((node) => node.isConnected)).toBe(true)
  expect(await output.evaluate((node) => node.scrollTop)).toBe(scrollTop)
  await expect(command.getByRole("button", { name: /Run/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  )
})

test("long tool groups bound details, fade scroll edges and retain opened output across folds", async ({
  page,
  renderingApp,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await writeFile(
    join(renderingApp.workspace, "large.ts"),
    Array.from({ length: 200 }, (_, index) => `Source row ${index + 1}`).join(
      "\n",
    ),
  )
  const prompt = "Check a long group of file reads."
  await renderingApp.send(prompt)
  await renderingApp.callTool(
    prompt,
    "read_file",
    { path: "large.ts", limit: 200 },
    24,
  )
  await renderingApp.append(prompt, "Checked the files.")
  await renderingApp.finish(prompt)
  const response = page.getByRole("region", { name: "Response", exact: true })
  const root = response.getByRole("button", { name: /^Worked for/ })
  await root.click()
  const group = response.getByRole("button", { name: "24 reads", exact: true })
  await group.click()
  const viewport = response.getByRole("region", {
    name: "Activity details",
    exact: true,
  })
  const edgeFades = () =>
    viewport.evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        top: Number.parseFloat(style.getPropertyValue("--activity-fade-top")),
        bottom: Number.parseFloat(
          style.getPropertyValue("--activity-fade-bottom"),
        ),
      }
    })
  const geometry = await viewport.evaluate((node) => ({
    height: node.clientHeight,
    scrollable: node.scrollHeight > node.clientHeight,
  }))
  expect(geometry.height).toBe(224)
  expect(geometry.scrollable).toBe(true)
  await expect(viewport).toHaveCSS("mask-image", /linear-gradient/)
  await expect.poll(edgeFades).toEqual({ top: 0, bottom: 24 })
  const rows = response.locator(".tool-cell")
  await expect(rows).toHaveCount(24)
  await rows.locator(".tool-trigger").evaluateAll((buttons) => {
    for (const button of buttons) (button as HTMLButtonElement).click()
  })
  const output = rows.first().locator("pre")
  const original = await output.elementHandle()
  if (!original) throw new Error("File output is missing.")
  await viewport.evaluate((node) => {
    node.scrollTop = 100
  })
  const scrollTop = await viewport.evaluate((node) => node.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  await group.click()
  await expect(output).toBeHidden()
  await group.click()
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBe(scrollTop)
  await root.click()
  await expect(output).toBeHidden()
  await root.click()
  expect(await original.evaluate((node) => node.isConnected)).toBe(true)
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollTop))
    .toBe(scrollTop)
  await expect(rows.locator('.tool-trigger[aria-expanded="true"]')).toHaveCount(
    24,
  )
  const last = rows.last()
  await last.locator(".tool-trigger").scrollIntoViewIfNeeded()
  await expect(last.locator(".tool-trigger")).toBeInViewport()
  await expect(last.locator("pre")).toContainText("Source row 200")
  await expect(last.locator(".tool-detail-surface")).toHaveCSS(
    "border-top-width",
    "0px",
  )
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect.poll(edgeFades).toEqual({ top: 24, bottom: 0 })
  // Reduced motion removes time-based effects, but an edge must still say
  // which direction contains hidden actions as the reader scrolls.
  await page.emulateMedia({ reducedMotion: "reduce" })
  await viewport.evaluate((node) => {
    node.scrollTop = 0
  })
  await expect.poll(edgeFades).toEqual({ top: 0, bottom: 24 })
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect.poll(edgeFades).toEqual({ top: 24, bottom: 0 })
  await viewport.screenshot({
    path: testInfo.outputPath("tool-detail-borderless.png"),
  })
})

test("short tool groups keep both edge rows fully visible without a fade", async ({
  page,
  renderingApp,
}) => {
  await writeFile(join(renderingApp.workspace, "short.ts"), "Short source.\n")
  const prompt = "Check a short group of file reads."
  await renderingApp.send(prompt)
  await renderingApp.callTool(
    prompt,
    "read_file",
    { path: "short.ts", limit: 1 },
    2,
  )
  await renderingApp.append(prompt, "Checked both files.")
  await renderingApp.finish(prompt)
  const response = page.getByRole("region", { name: "Response", exact: true })
  await response.getByRole("button", { name: /^Worked for/ }).click()
  await response.getByRole("button", { name: "2 reads", exact: true }).click()
  const viewport = response.getByRole("region", {
    name: "Activity details",
    exact: true,
  })
  await viewport.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      viewport.evaluate((node) => {
        const style = getComputedStyle(node)
        return {
          scrollable: node.scrollHeight > node.clientHeight,
          top: Number.parseFloat(style.getPropertyValue("--activity-fade-top")),
          bottom: Number.parseFloat(
            style.getPropertyValue("--activity-fade-bottom"),
          ),
        }
      }),
    )
    .toEqual({ scrollable: false, top: 0, bottom: 0 })
  const rows = viewport.getByRole("button", { name: /Read short.ts/ })
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toBeInViewport({ ratio: 1 })
  await expect(rows.last()).toBeInViewport({ ratio: 1 })
})

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`history disclosures respond immediately and retain opened content (${reducedMotion})`, async ({
    page,
    renderingApp,
  }) => {
    await page.emulateMedia({ reducedMotion })
    const prompt = "Check repeated history toggles."
    await renderingApp.send(prompt)
    await renderingApp.think(
      prompt,
      Array.from(
        { length: 100 },
        (_, index) => `Reasoning paragraph ${index + 1}.`,
      ).join("\n\n"),
    )
    await renderingApp.append(prompt, "Short final answer.")
    await renderingApp.finish(prompt)
    const response = page.getByRole("region", { name: "Response", exact: true })
    const toggle = response.getByRole("button", { name: /^Worked for/ })
    const panel = response.locator(".conversation-disclosure")
    await expect(panel).toBeHidden()
    await expect(panel.locator("ol")).toHaveCount(1)
    await page.reload()
    await expect(toggle).toBeVisible()
    await expect(panel.locator("ol")).toHaveCount(0)
    await toggle.click()
    const reasoning = response.getByRole("button", {
      name: "Reasoning",
      exact: true,
    })
    await reasoning.click()
    const details = response.locator(
      `[id="${await reasoning.getAttribute("aria-controls")}"]`,
    )
    await details.evaluate((node) => {
      node.scrollTop = 100
    })
    const initialScroll = await details.evaluate((node) => node.scrollTop)
    const frames = await toggle.evaluate(async (button: HTMLButtonElement) => {
      const panel = document.getElementById(
        button.getAttribute("aria-controls") ?? "",
      )
      const timeline = panel?.querySelector("ol")
      if (!panel || !timeline) throw new Error("History content is missing.")
      const frames: {
        closed: boolean
        height: number
        retained: boolean
        animations: number
      }[] = []
      for (let index = 0; index < 8; index += 1) {
        button.click()
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )
        frames.push({
          closed: panel.hidden === true,
          height: panel.getBoundingClientRect().height,
          retained: timeline === panel.querySelector("ol"),
          animations: panel.getAnimations().length,
        })
      }
      return frames
    })
    for (const [index, frame] of frames.entries()) {
      expect(frame.retained).toBe(true)
      expect(frame.animations).toBe(0)
      expect(frame.closed).toBe(index % 2 === 0)
      if (frame.closed) expect(frame.height).toBe(0)
      else expect(frame.height).toBeGreaterThan(30)
    }
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
    expect(await details.evaluate((node) => node.scrollTop)).toBe(initialScroll)
    await expect(
      response.getByText("Reasoning paragraph 1.", { exact: true }),
    ).toBeVisible()
    await toggle.focus()
    await page.keyboard.press("Enter")
    await expect(panel).toBeHidden()
    await expect(
      response.getByText("Short final answer.", { exact: true }),
    ).toBeVisible()
    await page.keyboard.press("Enter")
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
  })
}

test("preserves streamed reasoning and the final answer through completion and reload", async ({
  page,
  renderingApp,
}, testInfo) => {
  const prompt = "Check reasoning display identity"
  const interimText = "I will inspect the saved file."
  await writeFile(
    join(renderingApp.workspace, "hierarchy.txt"),
    "Saved file content.\n",
  )
  const fontSize = (locator: Locator) =>
    locator.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    )
  await renderingApp.send(prompt)
  await renderingApp.think(
    prompt,
    "**Inspecting output**\n\nChecking the complete reasoning body.",
  )
  await expect(
    page.getByRole("button", { name: "Reasoning…", exact: true }),
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Reasoning…", exact: true }).click()
  await expect(
    page
      .locator(".reasoning-trace")
      .getByText("Inspecting output", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText("Checking the complete reasoning body.", { exact: true }),
  ).toBeVisible()
  await renderingApp.append(prompt, interimText)
  await renderingApp.callTool(prompt, "read_file", { path: "hierarchy.txt" })
  await renderingApp.append(prompt, "The final answer is ready.")
  const finalMessage = page
    .locator(".markdown")
    .filter({ hasText: /^The final answer is ready\.$/ })
  await expect(finalMessage).toBeVisible()
  const liveFinalFontSize = await fontSize(finalMessage)
  await renderingApp.finish(prompt)
  await expect(finalMessage).toBeVisible()
  expect(await fontSize(finalMessage)).toBe(liveFinalFontSize)
  const response = page.getByRole("region", { name: "Response", exact: true })
  await page.getByRole("button", { name: /^Worked for/ }).click()
  await expect(response.getByText(interimText, { exact: true })).toHaveCount(1)
  await expect(response.getByText(interimText, { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Reasoning", exact: true }),
  ).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: "Reasoning", exact: true }),
  ).toHaveAttribute("aria-expanded", "true")
  await expect(
    page
      .locator(".reasoning-trace")
      .getByText("Inspecting output", { exact: true }),
  ).toBeVisible()
  const processMessage = response
    .locator(".markdown")
    .filter({ hasText: interimText })
  const reasoningBody = response.getByText(
    "Checking the complete reasoning body.",
    {
      exact: true,
    },
  )
  const processFontSize = await fontSize(processMessage)
  const reasoningFontSize = await fontSize(reasoningBody)
  expect(processFontSize).toBe(liveFinalFontSize)
  expect(reasoningFontSize).toBeLessThan(liveFinalFontSize)
  expect(
    await fontSize(
      response
        .locator(".reasoning-trace")
        .getByText("Inspecting output", { exact: true }),
    ),
  ).toBeLessThanOrEqual(reasoningFontSize)
  const row = response.locator(".tool-cell")
  const toolToggle = row.getByRole("button", { name: /Read.*hierarchy\.txt/ })
  expect(await fontSize(toolToggle)).toBe(reasoningFontSize)
  const metadataFontSize = await fontSize(
    response.locator(".message-actions time"),
  )
  expect(metadataFontSize).toBeLessThan(processFontSize)
  expect(metadataFontSize).toBeLessThan(reasoningFontSize)
  expect(
    await reasoningBody.evaluate((node) => getComputedStyle(node).color),
  ).not.toBe(
    await finalMessage.evaluate((node) => getComputedStyle(node).color),
  )
  await toolToggle.click()
  await expect(row.getByText(/Saved file content\./)).toBeVisible()
  expect(await fontSize(row.locator(".tool-output"))).toBeLessThanOrEqual(
    reasoningFontSize,
  )
  await page.screenshot({
    path: testInfo.outputPath("conversation-hierarchy-light.png"),
    animations: "disabled",
  })
  await page.reload()
  await expect(finalMessage).toBeVisible()
  expect(await fontSize(finalMessage)).toBe(liveFinalFontSize)
  await page.getByRole("button", { name: /^Worked for/ }).click()
  await expect(response.getByText(interimText, { exact: true })).toHaveCount(1)
  await expect(response.getByText(interimText, { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Reasoning", exact: true }),
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Reasoning", exact: true }).click()
  await expect(
    page
      .locator(".reasoning-trace")
      .getByText("Inspecting output", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText("Checking the complete reasoning body.", { exact: true }),
  ).toBeVisible()
})
