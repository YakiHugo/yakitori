import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"
import type { PdfAttachment } from "../../src/kernel/events.ts"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, type TestInfo } from "@playwright/test"

export async function createSmokeEnvironment(): Promise<
  Readonly<{
    root: string
    env: Readonly<Record<string, string>>
    cleanup(): Promise<void>
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-smoke-"))
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  const bin = join(root, "bin")
  try {
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(bin)])
    await writeFile(
      join(workspace, "smoke.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
        "base64",
      ),
    )
    // The subscription flow must never launch the developer's real CLI or
    // open an external browser. This owned process exposes a URL until canceled.
    await writeFile(
      join(bin, "codex"),
      `#!${process.execPath}\nconsole.log('Sign in: https://auth.openai.com/authorize?state=smoke');\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    )
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const excluded = new Set([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "YAKITORI_MODEL",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
  ])
  // Startup discovers CLI logins as well as API keys. Isolate both sources
  // so a real app launch still cannot use the developer's model accounts.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !excluded.has(entry[0]),
    ),
  )
  Object.assign(env, {
    PATH: `${bin}:${env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    GROK_CREDENTIALS: join(home, "grok-auth.json"),
    YAKITORI_HOME: home,
    YAKITORI_STORE_DIR: join(root, "store"),
    YAKITORI_WORKSPACE: workspace,
    YAKITORI_PROVIDER: "faux",
    YAKITORI_FAUX_SCENARIO: "text",
    HOST: "127.0.0.1",
    PORT: "0",
  })
  return {
    root,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export async function runFauxTurn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New session", exact: true }).click()
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  await composer.fill("Check the CI smoke flow.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(
    page.getByRole("main").getByText("Hello from faux.", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toHaveCount(0)
}

// A small explicit budget makes the real faux-provider loop stop deterministically.
// This traverses GUI -> RPC -> Session -> SQLite -> goal/changed notifications.
export async function runBudgetedGoal(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  await composer.fill("/goal")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Goal", exact: true })
    .fill("Verify the persistent goal runtime")
  await page
    .getByRole("spinbutton", { name: "Token budget (optional)" })
    .fill("1")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Goal limited", { exact: true })).toBeVisible()
  await expect(
    page.getByText("· 1,282 / 1 tokens", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Goal limited", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Verify the persistent goal runtime", { exact: true }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear goal", exact: true }).click()
  await expect(page.getByText("Goal limited", { exact: true })).toHaveCount(0)
}

// One process-boundary flow shared by browser and packaged Electron. All model
// traffic stays on this local endpoint, including the explicit connection test.
export const smokePdfBytes = pdfFixture(["Ordered PDF smoke original"])

export async function runProviderFlow(
  page: Page,
  testInfo: TestInfo,
  pdfOptions: Readonly<{
    browserPdf?: PdfAttachment
    downloadPdf?: () => Promise<Buffer>
  }> = {},
): Promise<void> {
  const requests: {
    method: string | undefined
    path: string | undefined
    authorization: string | undefined
    body: string
  }[] = []
  const endpoint = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [{ id: "smoke-model", input_modalities: ["text", "image"] }],
        }),
      )
      return
    }
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const completion = {
        id: `chatcmpl_smoke_${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "smoke-model",
      }
      const sent = JSON.parse(body) as {
        messages?: { role: string; content?: unknown }[]
      }
      if (
        sent.messages?.some(
          (message) =>
            message.role === "user" &&
            message.content === "Verify the configured provider turn.",
        ) &&
        !sent.messages.some((message) => message.role === "tool")
      ) {
        response.write(
          `data: ${JSON.stringify({
            ...completion,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "smoke_image",
                      type: "function",
                      function: {
                        name: "view_image",
                        arguments: JSON.stringify({ path: "smoke.png" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
        response.end(
          `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        )
        return
      }
      response.write(
        `data: ${JSON.stringify({
          ...completion,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Mock provider reply",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Provider source",
                      url: "https://example.org/source",
                      start_index: 0,
                      end_index: 4,
                    },
                  },
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Unavailable source",
                      url: "javascript:alert(1)",
                      start_index: 0,
                      end_index: 4,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({ ...completion, choices: [], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`,
      )
      response.end("data: [DONE]\n\n")
    })
  })
  try {
    endpoint.listen(0, "127.0.0.1")
    await once(endpoint, "listening")
    const address = endpoint.address()
    if (address === null || typeof address === "string")
      throw new Error("Provider mock TCP address is missing.")

    await openProviderSettings(page)
    await expect(
      page.getByRole("button", { name: "OpenAI", exact: true }),
    ).toBeVisible()
    const catalogPath = testInfo.outputPath("provider-catalog.png")
    await page.screenshot({ path: catalogPath, animations: "disabled" })
    await testInfo.attach("provider-catalog", {
      path: catalogPath,
      contentType: "image/png",
    })
    await page.getByRole("button", { name: "Codex CLI", exact: true }).click()
    const subscription = page.getByRole("dialog", {
      name: "Codex CLI",
      exact: true,
    })
    await expect(subscription.getByRole("status")).toHaveText(
      "Waiting for browser sign-in…",
    )
    await expect(
      subscription.getByRole("link", { name: "Open sign-in page ↗" }),
    ).toHaveAttribute("href", "https://auth.openai.com/authorize?state=smoke")
    await subscription
      .getByRole("button", { name: "Import existing account…" })
      .click()
    const accountImport = page.getByRole("dialog", {
      name: "Import Codex CLI account",
      exact: true,
    })
    await accountImport
      .getByRole("button", { name: "Use local CLI account" })
      .click()
    await expect(accountImport.getByRole("alert")).toContainText(
      "No ChatGPT account found",
    )
    const chooser = page.waitForEvent("filechooser")
    await accountImport.getByRole("button", { name: "Choose file…" }).click()
    await (await chooser).setFiles({
      name: "auth.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"OPENAI_API_KEY":"smoke-key"}'),
    })
    await expect(
      accountImport.getByRole("textbox", { name: "Account JSON" }),
    ).toHaveValue('{"OPENAI_API_KEY":"smoke-key"}')
    await accountImport
      .getByRole("button", { name: "Import account", exact: true })
      .click()
    await expect(accountImport.getByRole("alert")).toContainText(
      "API keys belong under OpenAI",
    )
    await accountImport
      .getByRole("textbox", { name: "Account JSON" })
      .fill('"secret-that-must-not-be-echoed')
    await accountImport
      .getByRole("button", { name: "Import account", exact: true })
      .click()
    await expect(accountImport.getByRole("alert")).toHaveText(
      "The account file is invalid JSON.",
    )
    const importPath = testInfo.outputPath("provider-account-import.png")
    await page.screenshot({ path: importPath, animations: "disabled" })
    await testInfo.attach("provider-account-import", {
      path: importPath,
      contentType: "image/png",
    })
    await page.keyboard.press("Escape")
    await expect(accountImport).toHaveCount(0)
    await page.getByRole("button", { name: "OpenAI", exact: true }).click()
    const openAIEditor = page.getByRole("dialog", {
      name: "OpenAI",
      exact: true,
    })
    await openAIEditor.getByText("Advanced settings", { exact: true }).click()
    const warmup = openAIEditor.getByRole("checkbox", {
      name: "Prepare the next request while tools run",
    })
    await expect(warmup).not.toBeChecked()
    await expect(openAIEditor.getByText(/may incur API usage/)).toBeVisible()
    await warmup.check()
    await expect(warmup).toBeChecked()
    const warmupPath = testInfo.outputPath("provider-warmup-opt-in.png")
    await page.screenshot({ path: warmupPath, animations: "disabled" })
    await testInfo.attach("provider-warmup-opt-in", {
      path: warmupPath,
      contentType: "image/png",
    })
    await page.keyboard.press("Escape")
    await expect(openAIEditor).toHaveCount(0)
    await page.getByRole("button", { name: "OpenAI", exact: true }).click()
    await openAIEditor.getByText("Advanced settings", { exact: true }).click()
    await expect(
      openAIEditor.getByRole("checkbox", {
        name: "Prepare the next request while tools run",
      }),
    ).not.toBeChecked()
    await page.keyboard.press("Escape")
    await expect(openAIEditor).toHaveCount(0)
    await page
      .getByRole("button", { name: "Google Gemini", exact: true })
      .click()
    const geminiEditor = page.getByRole("dialog", {
      name: "Google Gemini",
      exact: true,
    })
    await geminiEditor.getByText("Advanced settings", { exact: true }).click()
    await expect(geminiEditor.getByLabel("API protocol")).toHaveValue(
      "gemini_generate_content",
    )
    await expect(geminiEditor.getByLabel("API base URL")).toHaveValue(
      "https://generativelanguage.googleapis.com/v1beta",
    )
    await geminiEditor
      .getByLabel("API protocol")
      .selectOption("openai_chat_completions")
    await page.keyboard.press("Escape")
    await expect(geminiEditor).toHaveCount(0)
    await page
      .getByRole("button", { name: "Google Gemini", exact: true })
      .click()
    await geminiEditor.getByText("Advanced settings", { exact: true }).click()
    await expect(geminiEditor.getByLabel("API protocol")).toHaveValue(
      "gemini_generate_content",
    )
    await page.keyboard.press("Escape")
    await expect(geminiEditor).toHaveCount(0)
    const search = page.getByRole("searchbox", { name: "Find a provider" })
    await search.fill("DeepSeek")
    await expect(search).toHaveValue("DeepSeek")
    await expect(
      page.getByRole("button", { name: "OpenAI", exact: true }),
    ).toHaveCount(0)
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "DeepSeek", exact: true })
    await expect(
      editor.getByRole("textbox", { name: "API key", exact: true }),
    ).toBeFocused()
    await expect(
      editor.getByRole("textbox", { name: "API base URL", exact: true }),
    ).toBeHidden()
    const editorPath = testInfo.outputPath("provider-preset-editor.png")
    await page.screenshot({ path: editorPath, animations: "disabled" })
    await testInfo.attach("provider-preset-editor", {
      path: editorPath,
      contentType: "image/png",
    })
    await page.keyboard.press("Escape")
    await expect(editor).toHaveCount(0)
    await expect(search).toHaveValue("DeepSeek")
    await search.focus()
    await page.keyboard.press("Escape")
    await expect(search).toHaveValue("")
    await page.getByRole("button", { name: /^Custom provider/ }).click()
    await page.getByText("Advanced settings", { exact: true }).click()
    await page
      .getByRole("textbox", { name: "Connection name", exact: true })
      .fill("Smoke API")
    await page
      .getByRole("textbox", { name: "API key", exact: true })
      .fill("smoke-test-key")
    await page
      .getByRole("textbox", { name: "API base URL", exact: true })
      .fill(`http://127.0.0.1:${address.port}/v1`)
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click()
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Connection test succeeded." }),
    ).toBeVisible()
    expect(requests).toHaveLength(1)
    await page
      .getByRole("button", { name: "Add provider", exact: true })
      .click()
    await expect(page.getByRole("button", { name: /^Smoke API/ })).toBeVisible()
    await expect(
      page.getByRole("form", { name: "New provider", exact: true }),
    ).toHaveCount(0)
    await expect(page.getByRole("button", { name: /^Smoke API/ })).toBeEnabled()
    const enabled = page.getByRole("switch", { name: "Enable Smoke API" })
    await enabled.click()
    await expect(enabled).toHaveAttribute("aria-checked", "false")
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(enabled).toHaveAttribute("aria-checked", "true")
    const screenshotPath = testInfo.outputPath("provider-connection.png")
    await page.screenshot({ path: screenshotPath })
    await testInfo.attach("provider-connection", {
      path: screenshotPath,
      contentType: "image/png",
    })

    await page.getByRole("button", { name: "Back to app", exact: true }).click()
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Untitled session", exact: true }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Select model and effort", exact: true })
      .click()
    await page.getByRole("button", { name: "smoke-model", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Message the Mate", exact: true })
      .fill("Verify the configured provider turn.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByRole("main").getByText("Mock provider reply", { exact: true }),
    ).toBeVisible()
    const checkToolImage = async () => {
      await page
        .getByRole("button", { name: "Used tools · View image", exact: true })
        .click()
      await page.getByRole("button", { name: /^View image smoke\.png/ }).click()
      const parts = page.getByRole("region", {
        name: "Ordered tool result",
        exact: true,
      })
      await expect(
        parts.getByText("Read image: smoke.png", { exact: true }),
      ).toBeVisible()
      const image = parts.getByRole("img")
      await expect(image).toBeVisible()
      await expect
        .poll(() =>
          image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0)
      expect(
        await parts
          .locator(":scope > *")
          .evaluateAll((nodes) => nodes.map((node) => node.tagName)),
      ).toEqual(["PRE", "IMG"])
    }
    await checkToolImage()
    const sources = page.getByRole("region", { name: "Sources", exact: true })
    await expect(
      sources.getByRole("link", { name: "Provider source", exact: true }),
    ).toHaveAttribute("href", "https://example.org/source")
    await expect(
      sources.getByText("Unavailable source", { exact: true }),
    ).toBeVisible()
    await expect(
      sources.getByRole("link", { name: "Unavailable source", exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Interrupt", exact: true }),
    ).toHaveCount(0)
    await page.reload()
    await expect(
      page.getByRole("main").getByText("Mock provider reply", { exact: true }),
    ).toBeVisible()
    await expect(
      page
        .getByRole("region", { name: "Sources", exact: true })
        .getByRole("link", { name: "Provider source", exact: true }),
    ).toHaveAttribute("href", "https://example.org/source")
    await expect(
      page
        .getByRole("region", { name: "Sources", exact: true })
        .getByText("Unavailable source", { exact: true }),
    ).toBeVisible()
    await expect(
      page
        .getByRole("region", { name: "Sources", exact: true })
        .getByRole("link", { name: "Unavailable source", exact: true }),
    ).toHaveCount(0)
    await checkToolImage()
    const sourcesPath = testInfo.outputPath("citation-sources.png")
    await page.screenshot({ path: sourcesPath, animations: "disabled" })
    await testInfo.attach("citation-sources", {
      path: sourcesPath,
      contentType: "image/png",
    })
    await expect(
      page.getByRole("button", {
        name: "Select model and effort",
        exact: true,
      }),
    ).toContainText("smoke-model")

    await runOrderedInputFlow(page, testInfo)
    const orderedRequest = JSON.parse(requests.at(-1)?.body ?? "{}") as {
      messages: { role: string; content: unknown }[]
    }
    expect(
      orderedRequest.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content,
    ).toEqual([
      { type: "text", text: "Before attachment. " },
      {
        type: "image_url",
        image_url: {
          url: expect.stringMatching(/^data:image\/png;base64,/),
          detail: "high",
        },
      },
      { type: "text", text: "After attachment." },
    ])

    await runPdfInputFlow(page, testInfo, pdfOptions)
    const pdfRequest = JSON.parse(requests.at(-1)?.body ?? "{}") as {
      messages: { role: string; content: unknown }[]
    }
    const pdfContent = pdfRequest.messages
      .filter((message) => message.role === "user")
      .at(-1)?.content
    // Unknown custom endpoints remain conservative: request projection expands
    // the PDF at its authored slot while durable history retains the original.
    expect(pdfContent).toEqual([
      { type: "text", text: "Before PDF. " },
      { type: "text", text: expect.stringContaining("PDF ordered-smoke.pdf") },
      {
        type: "image_url",
        image_url: {
          url: expect.stringMatching(/^data:image\/png;base64,/),
          detail: "high",
        },
      },
      { type: "text", text: "After PDF." },
    ])

    await openProviderSettings(page)
    await expect(page.getByRole("button", { name: /^Smoke API/ })).toBeVisible()
    await page.getByRole("tab", { name: "Usage", exact: true }).click()
    const usage = page.getByRole("region", { name: "Provider usage" })
    await expect(
      usage.getByRole("cell").filter({ hasText: "Smoke API" }),
    ).toContainText("smoke-model")
    await expect(
      usage
        .getByRole("row")
        .filter({ hasText: "Smoke API" })
        .getByRole("cell", { name: "—", exact: true }),
    ).toBeVisible()
    await page.getByRole("tab", { name: "Providers", exact: true }).click()
    await page.getByRole("button", { name: /^Smoke API/ }).click()
    await expect(
      page.getByRole("textbox", { name: "API key", exact: true }),
    ).toHaveValue("")
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click()
    await expect(
      page.getByRole("form", { name: "Edit provider", exact: true }),
    ).toHaveCount(0)
    await page.getByRole("button", { name: /^Smoke API/ }).click()
    await expect(
      page.getByRole("textbox", { name: "API key", exact: true }),
    ).toHaveValue("")
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click()
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Connection test succeeded." }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Remove provider", exact: true })
      .click()
    await page.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(page.getByRole("button", { name: /^Smoke API/ })).toHaveCount(
      0,
    )
    await expect(page.getByText("Add provider", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Back to app", exact: true }).click()
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Untitled session", exact: true }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Select model and effort", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "smoke-model", exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "scripted", exact: true }),
    ).toBeVisible()
    await page.keyboard.press("Escape")
    expect(requests.length).toBeGreaterThanOrEqual(3)
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "POST",
        path: "/v1/chat/completions",
        authorization: "Bearer smoke-test-key",
      })
      expect(JSON.parse(request.body)).toMatchObject({
        model: "smoke-model",
        stream: true,
      })
    }
  } finally {
    endpoint.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

async function openProviderSettings(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Open account menu", exact: true })
    .click()
  await page.getByRole("menuitem", { name: /^Providers/ }).click()
  await expect(
    page.getByRole("region", { name: "Provider settings", exact: true }),
  ).toBeVisible()
}

// Browser smoke owns only the renderer's attachment-import boundary. Packaged
// Electron uses its real preload/IPC importer on exactly the same pasted bytes.
async function runOrderedInputFlow(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const toolImage = page
    .getByRole("region", { name: "Ordered tool result", exact: true })
    .getByRole("img")
  const sourceUrl = await toolImage.getAttribute("src")
  if (sourceUrl === null) throw new Error("Smoke tool image URL is missing.")
  const usesDesktop = await page.evaluate(
    () => window.yakitoriDesktop !== undefined,
  )
  await page.evaluate(
    async ({ sourceUrl, usesDesktop }) => {
      const response = await fetch(sourceUrl)
      if (!response.ok) throw new Error("Smoke image could not be loaded.")
      const bytes = await response.arrayBuffer()
      if (!usesDesktop) {
        const path = new URL(sourceUrl).pathname
        const match = /^\/rollouts\/([^/]+)\/assets\/(.+)$/.exec(path)
        if (!match?.[1] || !match[2])
          throw new Error("Smoke asset URL is not rollout-owned.")
        const rolloutId = decodeURIComponent(match[1])
        const assetPath = match[2].split("/").map(decodeURIComponent).join("/")
        Object.defineProperty(window, "yakitoriDesktop", {
          configurable: true,
          value: {
            importAttachmentFiles: async () => [
              {
                name: "ordered-smoke.png",
                mediaType: "image/png",
                detail: "high",
                sizeBytes: bytes.byteLength,
                file: {
                  rolloutId,
                  path: assetPath,
                },
              },
            ],
            discardDraftAttachments: async () => {},
          },
        })
      }
    },
    { sourceUrl, usesDesktop },
  )
  try {
    const editor = page.getByRole("textbox", {
      name: "Message the Mate",
      exact: true,
    })
    await editor.fill("Before attachment. After attachment.")
    await editor.evaluate((node) => {
      const text = node.querySelector("p")?.firstChild
      if (text?.nodeType !== Node.TEXT_NODE)
        throw new Error("Smoke editor text is missing.")
      const selection = window.getSelection()
      const range = document.createRange()
      range.setStart(text, "Before attachment. ".length)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    })
    await editor.evaluate(async (node, sourceUrl) => {
      const response = await fetch(sourceUrl)
      const bytes = await response.arrayBuffer()
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File([bytes], "ordered-smoke.png", { type: "image/png" }),
      )
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      )
    }, sourceUrl)
    await expect(
      editor.getByRole("button", {
        name: "Preview attached image ordered-smoke.png",
      }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    // Wide viewports also contain hidden navigation previews of each answer.
    // Count actual response regions, retaining the duplicate-reply check.
    const responses = page.getByRole("region", {
      name: "Response",
      exact: true,
    })
    await expect(responses).toHaveCount(2)
    await expect(
      responses.getByText("Mock provider reply", { exact: true }),
    ).toHaveCount(2)
    await expect(
      page.getByRole("button", { name: "Interrupt", exact: true }),
    ).toHaveCount(0)
    const checkOrder = async () => {
      const before = page
        .getByRole("main")
        .locator(".message-bubble")
        .filter({ hasText: "Before attachment." })
      await expect(before).toBeVisible()
      const message = before.locator("..")
      expect(
        await message
          .locator(":scope > .message-bubble, :scope > .message-attachments")
          .evaluateAll((nodes) =>
            nodes.map((node) =>
              node.querySelector("img") ? "image" : node.textContent,
            ),
          ),
      ).toEqual(["Before attachment. ", "image", "After attachment."])
      const image = message.getByRole("img", {
        name: "ordered-smoke.png",
        exact: true,
      })
      await expect(image).toBeVisible()
      await expect
        .poll(() =>
          image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0)
    }
    await checkOrder()
    await page.reload()
    await checkOrder()
    const screenshot = testInfo.outputPath("ordered-user-input.png")
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await testInfo.attach("ordered-user-input", {
      path: screenshot,
      contentType: "image/png",
    })
  } finally {
    if (!usesDesktop)
      await page.evaluate(() => {
        Reflect.deleteProperty(window, "yakitoriDesktop")
      })
  }
}

async function runPdfInputFlow(
  page: Page,
  testInfo: TestInfo,
  options: Readonly<{
    browserPdf?: PdfAttachment
    downloadPdf?: () => Promise<Buffer>
  }>,
): Promise<void> {
  const usesDesktop = await page.evaluate(
    () => window.yakitoriDesktop !== undefined,
  )
  if (!usesDesktop) {
    if (options.browserPdf === undefined)
      throw new Error("Browser PDF import fixture is missing.")
    await page.evaluate(
      (pdf) =>
        Object.defineProperty(window, "yakitoriDesktop", {
          configurable: true,
          value: {
            importAttachmentFiles: async () => [pdf],
            discardDraftAttachments: async () => {},
          },
        }),
      options.browserPdf,
    )
  }
  try {
    const editor = page.getByRole("textbox", {
      name: "Message the Mate",
      exact: true,
    })
    await editor.fill("Before PDF. After PDF.")
    await editor.evaluate((node) => {
      const text = node.querySelector("p")?.firstChild
      if (text?.nodeType !== Node.TEXT_NODE)
        throw new Error("PDF smoke editor text missing")
      const range = document.createRange()
      range.setStart(text, "Before PDF. ".length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    })
    await editor.evaluate((node, base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      )
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File([bytes], "ordered-smoke.pdf", { type: "application/pdf" }),
      )
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      )
    }, smokePdfBytes.toString("base64"))
    await expect(
      editor.getByRole("button", {
        name: "Open attached PDF ordered-smoke.pdf",
      }),
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Remove ordered-smoke.pdf", exact: true })
      .click()
    await editor.focus()
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    )
    await expect(
      editor.getByRole("button", {
        name: "Open attached PDF ordered-smoke.pdf",
      }),
    ).toBeVisible()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByRole("region", { name: "Response", exact: true }),
    ).toHaveCount(3)
    await expect(
      page.getByRole("button", { name: "Interrupt", exact: true }),
    ).toHaveCount(0)
    const checkOrder = async () => {
      const before = page
        .getByRole("main")
        .locator(".message-bubble")
        .filter({ hasText: "Before PDF." })
      await expect(before).toBeVisible()
      const message = before.locator("..")
      expect(
        await message
          .locator(
            ':scope > .message-bubble, :scope > section[aria-label="PDF attachment ordered-smoke.pdf"]',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) =>
              node.tagName === "SECTION" ? "PDF" : node.textContent,
            ),
          ),
      ).toEqual(["Before PDF. ", "PDF", "After PDF."])
      await expect(
        message.getByRole("link", { name: "Download PDF", exact: true }),
      ).toBeVisible()
    }
    await checkOrder()
    await page.reload()
    await checkOrder()
    let downloaded: Buffer
    if (options.downloadPdf) downloaded = await options.downloadPdf()
    else {
      const pending = page.waitForEvent("download")
      await page
        .getByRole("main")
        .getByRole("link", { name: "Download PDF", exact: true })
        .click()
      const download = await pending
      expect(download.suggestedFilename()).toBe("ordered-smoke.pdf")
      expect(await download.failure()).toBeNull()
      const stream = await download.createReadStream()
      if (stream === null) throw new Error("PDF download stream missing")
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      downloaded = Buffer.concat(chunks)
    }
    expect(downloaded).toEqual(smokePdfBytes)
    const screenshot = testInfo.outputPath("ordered-pdf-input.png")
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await testInfo.attach("ordered-pdf-input", {
      path: screenshot,
      contentType: "image/png",
    })
  } finally {
    if (!usesDesktop)
      await page.evaluate(() =>
        Reflect.deleteProperty(window, "yakitoriDesktop"),
      )
  }
}
