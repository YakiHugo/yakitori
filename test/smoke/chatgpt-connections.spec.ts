import { expect, test, type WebSocketRoute } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import type { ChatGPTConnectionState } from "../../src/server/chatgpt-connections.ts"

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
          result = {}
          break
        case "provider/configuration/read":
          result = {
            providers: [],
            presets: [],
            subscriptions: [
              { id: "codex", name: "Codex CLI", available: false },
            ],
          }
          break
        case "provider/list":
          result = {
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
  const originalURL = page.url()
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
  await expect(page.getByText("Using ChatGPT plan")).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("chatgpt-accounts.png"),
    fullPage: true,
  })
  await page.getByRole("button", { name: "Sign out Personal" }).click()
  await expect(
    page.getByText(/Remote revocation wasn’t confirmed/),
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Manage usage ↗" }).first(),
  ).toHaveAttribute("href", "https://chatgpt.com/settings/usage")
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
