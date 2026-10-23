import { expect, test, type WebSocketRoute } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import type { ChatGPTConnectionState } from "../../src/server/chatgpt-connections.ts"
import { providerPresets } from "../../src/runtime/provider-presets.ts"

let server: ViteDevServer
let url: string
test.beforeAll(async () => {
  // Only serves renderer assets. Every application RPC is intercepted below;
  // no Yakitori sidecar, OAuth runtime, credentials or live model is involved.
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string")
    throw new Error("Missing test server address")
  url = `http://127.0.0.1:${address.port}/test/smoke/renderer/chatgpt-settings.html`
})
test.afterAll(async () => {
  await server?.close()
})

test("runtime settings persist subagent model selection and restore effective state", async ({
  page,
}, testInfo) => {
  let enabled = false
  let version = "first"
  const writes: Record<string, unknown>[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.routeWebSocket("**/rpc", (route) => {
    route.onMessage((message) => {
      const input = JSON.parse(String(message)) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      let result: unknown = {}
      if (input.method === "provider/configuration/read")
        result = { providers: [], presets: [], subscriptions: [] }
      if (input.method === "chatgpt/read")
        result = { accounts: [], welcomeRequired: false }
      if (input.method === "config/write") {
        writes.push(input.params)
        enabled = input.params.value === true
        version = "second"
      }
      if (input.method === "config/read" || input.method === "config/write")
        result = {
          configuration: { agents: { exposeModelOverrides: enabled } },
          effective: { agents: { expose_model_overrides: enabled } },
          origins: {},
          layers: [{ source: "user", path: "/home/config.toml", version }],
        }
      route.send(JSON.stringify({ id: input.id, result }))
    })
  })
  await page.goto(url)
  await page.getByRole("button", { name: "Runtime", exact: true }).click()
  const control = page.getByRole("switch", { name: "Subagent model selection" })
  await expect(control).toHaveAttribute("aria-checked", "false")
  await control.click()
  await expect
    .poll(() => writes)
    .toEqual([
      {
        keyPath: ["agents", "expose_model_overrides"],
        value: true,
        expectedVersion: "first",
      },
    ])
  await expect(page.getByText("Applying changes…")).toHaveCount(0)
  await page.getByRole("button", { name: "General", exact: true }).click()
  await page.getByRole("button", { name: "Runtime", exact: true }).click()
  await expect(control).toHaveAttribute("aria-checked", "true")
  await page.screenshot({
    path: testInfo.outputPath("runtime-settings.png"),
    fullPage: true,
  })
  expect(errors).toEqual([])
})

test("account setup shows reference models and retries authenticated discovery", async ({
  page,
}, testInfo) => {
  let attempts = 0
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.routeWebSocket("**/rpc", (route) => {
    route.onMessage((message) => {
      const input = JSON.parse(String(message)) as {
        id: number
        method: string
      }
      let result: unknown = {}
      if (input.method === "provider/configuration/read")
        result = { providers: [], presets: providerPresets, subscriptions: [] }
      if (input.method === "chatgpt/read")
        result = { accounts: [], welcomeRequired: false }
      if (input.method === "provider/configuration/models") {
        attempts++
        if (attempts === 1) {
          route.send(
            JSON.stringify({
              id: input.id,
              error: {
                code: -32000,
                message: "Catalog temporarily unavailable",
              },
            }),
          )
          return
        }
        result = [{ id: "account-coder", displayName: "Account coder" }]
      }
      route.send(JSON.stringify({ id: input.id, result }))
    })
  })
  await page.goto(url)
  await page.getByRole("button", { name: "Add account", exact: true }).click()
  await page.getByRole("button", { name: "Kimi Code", exact: true }).click()
  await page.getByText("Model defaults (optional)", { exact: true }).click()
  await expect(
    page.getByRole("switch", { name: /Enable kimi-for-coding/ }),
  ).toHaveAttribute("aria-checked", "true")
  await expect(
    page.getByText(
      "Service defaults shown below. Account access has not been checked.",
    ),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Load models|Refresh models/ }),
  ).toHaveCount(0)
  expect(attempts).toBe(0)
  await page.getByLabel("API key", { exact: true }).fill("fake-kimi-key")
  await expect(page.getByRole("alert")).toContainText(
    "Catalog temporarily unavailable",
  )
  await page.getByRole("button", { name: "Retry models" }).click()
  await expect(
    page.getByRole("switch", { name: /Enable Account coder/ }),
  ).toHaveAttribute("aria-checked", "true")
  await expect(
    page.getByRole("switch", { name: /Enable kimi-for-coding/ }),
  ).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath("account-models.png"),
    fullPage: true,
  })
  expect(errors).toEqual([])
})

test("subscription setup connects locally and returns to the desktop window", async ({
  page,
}) => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let connected = false
  await page.addInitScript(() => {
    Object.defineProperty(window, "yakitoriDesktop", {
      value: {
        focusWindow: async () => {
          document.documentElement.dataset.focusReturns = String(
            Number(document.documentElement.dataset.focusReturns ?? 0) + 1,
          )
        },
      },
    })
  })
  await page.routeWebSocket("**/rpc", (route) => {
    route.onMessage((message) => {
      const input = JSON.parse(String(message)) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      calls.push(input)
      if (input.method === "provider/subscription/login") connected = true
      const subscriptions = [
        {
          id: "codex",
          name: "Codex CLI",
          available: connected,
          ...(connected ? { login: { state: "succeeded" } } : {}),
        },
      ]
      const result =
        input.method === "provider/subscription/login"
          ? subscriptions
          : input.method === "provider/configuration/read"
            ? { providers: [], presets: [], subscriptions }
            : input.method === "chatgpt/read"
              ? { accounts: [], welcomeRequired: false }
              : input.method === "provider/list"
                ? { accounts: [], providers: [] }
                : {}
      route.send(JSON.stringify({ id: input.id, result }))
    })
  })
  await page.goto(url)
  await page.getByRole("button", { name: "Add account", exact: true }).click()
  await page.getByRole("button", { name: "Codex CLI", exact: true }).click()
  await expect(
    page.getByText(
      "Account connected. Its models are available in the conversation model picker.",
    ),
  ).toBeVisible()
  expect(
    calls
      .filter((call) => call.method === "provider/subscription/login")
      .map((call) => call.params),
  ).toEqual([{ id: "codex" }])
  await expect(page.locator("html")).toHaveAttribute("data-focus-returns", "1")
})

test("ChatGPT settings render account lifecycle with fake RPC only", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let state: ChatGPTConnectionState = { accounts: [], welcomeRequired: false }
  let socket: WebSocketRoute | undefined
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  )
  await page.routeWebSocket("**/rpc", (route) => {
    socket = route
    route.onMessage((message) => {
      const input = JSON.parse(String(message)) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      calls.push(input)
      let result: unknown
      switch (input.method) {
        case "initialize":
        case "server/ping":
          result = {}
          break
        case "provider/configuration/read":
          result = {
            providers: state.accounts.length
              ? [
                  {
                    id: "api-account",
                    credential: "stored",
                    configuration: {
                      name: "OpenAI API",
                      service: "openai",
                      authentication: "stored",
                      baseURL: "https://api.example.test/v1",
                      wireApi: "openai_responses",
                      models: [{ id: "qa-model" }],
                    },
                  },
                ]
              : [],
            presets: [],
            subscriptions: [
              { id: "codex", name: "Codex CLI", available: false },
            ],
          }
          break
        case "provider/list":
          result = {
            accounts: [],
            providers: state.accounts
              .filter((account) => account.state === "connected")
              .map((account) => ({
                name: account.providerId,
                displayName: `ChatGPT · ${account.label}`,
                models: [
                  {
                    id: "qa-model",
                    displayName: "QA model",
                    instructionProfileId: "test",
                  },
                ],
              })),
            defaultProvider: "chatgpt-personal",
            defaultModel: "qa-model",
          }
          break
        case "provider/models/read":
          result = {
            provider: input.params.provider,
            version: "test",
            models: [{ id: "qa-model", displayName: "QA model" }],
            settings: {},
          }
          break
        case "usage/read":
          result = {
            usage: {
              generatedAt: new Date().toISOString(),
              totals: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                turns: 0,
              },
              days: [],
              models: [],
              modelDays: [],
              threads: [],
            },
          }
          break
        case "chatgpt/read":
          result = state
          break
        case "chatgpt/signIn":
          state = {
            ...state,
            attempt: { id: `attempt-${calls.length}`, state: "waiting" },
          }
          result = state
          break
        case "chatgpt/cancel":
          state = {
            ...state,
            attempt: { id: String(input.params.attemptId), state: "cancelled" },
          }
          result = state
          break
        case "chatgpt/acknowledge":
          state = { ...state, welcomeRequired: false }
          result = state
          break
        case "chatgpt/signOut":
          state = {
            ...state,
            accounts: state.accounts.map((account) =>
              account.id === input.params.accountId
                ? {
                    ...account,
                    state: "signed_out",
                    remoteRevocation: "unconfirmed",
                  }
                : account,
            ),
          }
          result = state
          break
        default:
          throw new Error(`Unexpected RPC: ${input.method}`)
      }
      route.send(JSON.stringify({ id: input.id, result }))
    })
  })
  const notify = () =>
    socket?.send(
      JSON.stringify({ method: "provider/configuration/changed", params: {} }),
    )
  await page.goto(url)
  await page.getByRole("button", { name: "Add account", exact: true }).click()
  const originalURL = page.url()
  await expect(
    page.getByText("Use your ChatGPT plan", { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("complementary", { name: "Settings navigation" }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toHaveCount(0)
  await page.getByRole("button", { name: "ChatGPT", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Continue with ChatGPT" }).dblclick()
  await expect(
    page.getByText("Waiting for sign-in in your system browser…"),
  ).toBeVisible()
  expect(calls.filter((call) => call.method === "chatgpt/signIn")).toHaveLength(
    1,
  )
  const firstAttempt = state.attempt?.id
  await page.screenshot({
    path: testInfo.outputPath("chatgpt-waiting.png"),
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect
    .poll(() => calls.find((call) => call.method === "chatgpt/cancel")?.params)
    .toEqual({ attemptId: firstAttempt })
  expect(page.url()).toBe(originalURL)
  await page.getByRole("button", { name: "ChatGPT", exact: true }).click()
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click()
  await expect(
    page.getByText("Waiting for sign-in in your system browser…"),
  ).toBeVisible()
  state = {
    accounts: [
      {
        id: "personal",
        label: "Personal",
        email: "example@example.test",
        providerId: "chatgpt-personal",
        state: "connected",
      },
    ],
    attempt: { id: state.attempt?.id ?? "", state: "succeeded" },
    welcomeRequired: true,
  }
  notify()
  await expect(
    page.getByRole("dialog", { name: "You’re using your ChatGPT plan" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Got it" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "Add account" }).click()
  await page.getByRole("button", { name: "ChatGPT", exact: true }).click()
  await page.getByRole("textbox", { name: "Account label" }).fill("Work")
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click()
  await expect(
    page.getByText("Waiting for sign-in in your system browser…"),
  ).toBeVisible()
  state = {
    accounts: [
      ...state.accounts,
      {
        id: "work",
        label: "Work",
        email: "example@example.test",
        providerId: "chatgpt-work",
        state: "identity_only",
      },
    ],
    attempt: { id: state.attempt?.id ?? "", state: "identity_only" },
    welcomeRequired: false,
  }
  notify()
  await expect(
    page.getByText("Signed in. ChatGPT plan usage wasn’t enabled."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Done" }).click()
  const accounts = page.getByRole("region", { name: "Configured providers" })
  await expect(accounts.getByText("Personal", { exact: true })).toBeVisible()
  await expect(accounts.getByText("Work", { exact: true })).toBeVisible()
  await expect(accounts.getByText("OpenAI API", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Select model and effort" }),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("chatgpt-accounts.png"),
    fullPage: true,
  })
  await accounts.getByRole("button", { name: /^Personal/ }).click()
  await expect(
    page
      .getByRole("region", { name: "Account models" })
      .getByRole("switch", { name: /Enable QA model/ }),
  ).toHaveAttribute("aria-checked", "true")
  await expect(page.getByRole("tab")).toHaveCount(0)
  expect(
    calls
      .filter((call) => call.method === "provider/models/read")
      .map((call) => call.params),
  ).toEqual([{ provider: "chatgpt-personal" }])
  await page.getByRole("button", { name: "Sign out Personal" }).click()
  await expect(
    page.getByText(/Remote revocation wasn’t confirmed/),
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Manage usage ↗" }).first(),
  ).toHaveAttribute("href", "https://chatgpt.com/settings/usage")
  await page
    .getByRole("button", { name: "Back to accounts", exact: true })
    .click()
  await accounts.getByRole("button", { name: /^Work/ }).click()
  await expect(
    page.getByText("Reconnect this account to manage its models."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Enable plan usage for Work" }).click()
  await expect(
    page.getByText("Waiting for sign-in in your system browser…"),
  ).toBeVisible()
  const navigatingAttempt = state.attempt?.id
  await page.getByRole("button", { name: "Cancel sign-in" }).click()
  await page.getByRole("button", { name: "Back to app" }).click()
  await expect(
    page.getByRole("heading", { name: "Conversation" }),
  ).toBeVisible()
  expect(
    calls.some(
      (call) =>
        call.method === "chatgpt/cancel" &&
        call.params.attemptId === navigatingAttempt,
    ),
  ).toBe(true)
  expect(
    calls.some((call) => call.method.startsWith("provider/subscription/")),
  ).toBe(false)
  expect(pageErrors).toEqual([])
  expect(page.url()).toBe(originalURL)
})
