import { expect, test } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import type { ApiSubscriptionSummary } from "../../src/protocol/application.ts"
import type { ProviderConfigurationResponse } from "../../src/protocol/providers.ts"

let server: ViteDevServer
let url: string
test.beforeAll(async () => {
  // Exercise the real renderer and RPC client with owned responses only.
  // This fixture never starts a sidecar or reads credentials or paid APIs.
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string")
    throw new Error("Missing test server address")
  url = `http://127.0.0.1:${address.port}/test/smoke/renderer/account-financials.html`
})
test.afterAll(async () => {
  await server?.close()
})

test("account financials preserve amounts, explain key limits, and replace failed refreshes with unknown", async ({
  page,
}, testInfo) => {
  const summaries: Record<string, ApiSubscriptionSummary> = {
    "deepseek-work": {
      provider: "deepseek-work",
      displayName: "DeepSeek work",
      availability: "available",
      credentialKind: "api_key",
      usage: { status: "unavailable", reason: "not_supported" },
      financials: {
        status: "available",
        metrics: [
          { kind: "balance", currency: "CNY", amount: -0.25 },
          { kind: "granted_balance", currency: "CNY", amount: 0 },
          { kind: "cash_balance", currency: "CNY", amount: 12.345678 },
        ],
      },
    },
    "router-work": {
      provider: "router-work",
      displayName: "OpenRouter work",
      availability: "available",
      credentialKind: "api_key",
      usage: { status: "unavailable", reason: "not_supported" },
      financials: {
        status: "available",
        metrics: [
          { kind: "key_remaining", currency: "USD", amount: 3.25 },
          { kind: "key_limit", currency: "USD", amount: 10 },
          { kind: "key_usage", currency: "USD", amount: 106.75 },
        ],
        keyLimitReset: "monthly",
      },
    },
  }
  const configuration: ProviderConfigurationResponse = {
    providers: Object.values(summaries).map((summary) => ({
      id: summary.provider,
      credential: "stored",
      configuration: {
        name: summary.displayName,
        wireApi: "openai_chat_completions",
        baseURL: "https://unused.example.test",
        enabled: true,
        models: [],
      },
    })),
    presets: [],
    subscriptions: [],
  }
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.routeWebSocket("**/rpc", (route) => {
    route.onMessage((message) => {
      const input = JSON.parse(String(message)) as {
        id: number
        method: string
        params: { provider?: string }
      }
      let result: unknown = {}
      if (input.method === "provider/configuration/read") result = configuration
      if (input.method === "subscription/read") {
        result = {
          subscription: summaries[input.params.provider ?? ""],
          fetchedAt: Date.UTC(2026, 10, 8, 12, 30),
        }
      }
      route.send(JSON.stringify({ id: input.id, result }))
    })
  })
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto(url)
  const deepseek = page.getByRole("region", { name: "DeepSeek work" })
  const router = page.getByRole("region", { name: "OpenRouter work" })
  await expect(deepseek.getByText("CNY -0.25", { exact: true })).toBeVisible()
  await expect(deepseek.getByText("CNY 0.00", { exact: true })).toBeVisible()
  await expect(deepseek.getByText("CNY 12.345678")).toBeVisible()
  await expect(router.getByText("API key remaining budget")).toBeVisible()
  await expect(router.getByText("API key lifetime usage")).toBeVisible()
  await expect(router.getByText("USD 106.75")).toBeVisible()
  await expect(router.getByText("API key budget resets monthly.")).toBeVisible()
  await expect(
    router.getByText(/other account or organization limits/),
  ).toBeVisible()
  await expect(
    router.getByText("Account balance", { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  await expect(page.getByText(/%|not supported/)).toHaveCount(0)

  await page.getByRole("button", { name: "Show OpenRouter status" }).click()
  const status = page.getByRole("region", { name: "Session status" })
  await expect(status.getByText("USD 3.25")).toBeVisible()
  await expect(status.locator("time")).toHaveAttribute(
    "datetime",
    "2026-11-08T12:30:00.000Z",
  )
  await page.screenshot({ path: testInfo.outputPath("account-financials.png") })
  await status.getByRole("button", { name: "Close" }).click()
  await expect(status).toHaveCount(0)

  const routerSummary = summaries["router-work"]
  const deepseekSummary = summaries["deepseek-work"]
  if (!routerSummary || !deepseekSummary) throw new Error("Missing QA accounts")
  summaries["router-work"] = {
    ...routerSummary,
    financials: {
      status: "available",
      metrics: [{ kind: "key_usage", currency: "USD", amount: 106.75 }],
      unlimited: true,
    },
  }
  await page.getByRole("button", { name: "Refresh accounts" }).click()
  await expect(router.getByText("No budget limit configured")).toBeVisible()
  await expect(
    router.getByText(/does not mean the account has unlimited funds/),
  ).toBeVisible()
  await expect(router.getByText("USD 3.25")).toHaveCount(0)
  await expect(router.getByText(/budget resets/)).toHaveCount(0)
  await page.getByRole("button", { name: "Show OpenRouter status" }).click()
  await expect(status.getByText("No budget limit configured")).toBeVisible()
  await expect(status.getByText("USD 3.25")).toHaveCount(0)
  await status.getByRole("button", { name: "Close" }).click()
  await page.setViewportSize({ width: 480, height: 900 })
  await expect(router.getByText("No budget limit configured")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    480,
  )
  await page.screenshot({
    path: testInfo.outputPath("account-financials-narrow.png"),
  })

  summaries["deepseek-work"] = {
    ...deepseekSummary,
    financials: { status: "unavailable", reason: "permission_denied" },
  }
  summaries["router-work"] = {
    ...routerSummary,
    financials: { status: "unavailable", reason: "temporarily_unavailable" },
  }
  await page.getByRole("button", { name: "Refresh accounts" }).click()
  await expect(deepseek.getByText(/Balance and budget unknown/)).toBeVisible()
  await expect(deepseek.getByText(/does not have permission/)).toBeVisible()
  await expect(router.getByText(/Could not refresh them/)).toBeVisible()
  await expect(page.getByText(/CNY |USD /)).toHaveCount(0)
  await page.getByRole("button", { name: "Show OpenRouter status" }).click()
  await expect(status.getByText(/Balance and budget unknown/)).toBeVisible()
  await expect(status.getByText("No budget limit configured")).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath("account-financials-unknown.png"),
  })
  expect(errors).toEqual([])
})
