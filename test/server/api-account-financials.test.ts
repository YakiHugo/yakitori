import { afterEach, expect, it, vi } from "vitest"
import { readAccountUsage } from "../../src/server/account-usage.ts"
import type { ProviderConfiguration } from "../../src/protocol/providers.ts"

const config = (service: string, baseURL: string): ProviderConfiguration => ({
  name: "API account",
  service,
  baseURL,
  authentication: "stored",
  wireApi: "openai_chat_completions",
  models: [],
})
const read = (configuration: ProviderConfiguration, connected = true) =>
  readAccountUsage({
    id: "account-one",
    configuration,
    connected,
    apiKey: "test-key",
  })
afterEach(() => vi.restoreAllMocks())

it("reads separate DeepSeek balances without treating zero as missing or currencies as interchangeable", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      is_available: false,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "0.00",
          granted_balance: "0.00",
          topped_up_balance: "0.00",
        },
        {
          currency: "USD",
          total_balance: "12.50",
          granted_balance: "2.50",
          topped_up_balance: "10.00",
        },
      ],
    }),
  )
  const result = await read(config("deepseek", "https://api.deepseek.com/v1"))
  expect(result.subscription.financials).toEqual({
    status: "available",
    metrics: [
      { kind: "balance", currency: "CNY", amount: 0 },
      { kind: "granted_balance", currency: "CNY", amount: 0 },
      { kind: "cash_balance", currency: "CNY", amount: 0 },
      { kind: "balance", currency: "USD", amount: 12.5 },
      { kind: "granted_balance", currency: "USD", amount: 2.5 },
      { kind: "cash_balance", currency: "USD", amount: 10 },
    ],
  })
  expect(fetch).toHaveBeenCalledWith(
    "https://api.deepseek.com/user/balance",
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer test-key", Accept: "application/json" },
    }),
  )
})

it.each([
  ["cn", "CNY"],
  ["ai", "USD"],
])("keeps Kimi %s currency and negative cash from the provider, not reconstructed totals", async (region, currency) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      code: 0,
      status: true,
      data: { available_balance: 5, voucher_balance: 5, cash_balance: -2 },
    }),
  )
  const result = await read(
    config("moonshot", `https://api.moonshot.${region}/v1`),
  )
  expect(result.subscription.financials).toEqual({
    status: "available",
    metrics: [
      { kind: "balance", currency, amount: 5 },
      { kind: "granted_balance", currency, amount: 5 },
      { kind: "cash_balance", currency, amount: -2 },
    ],
  })
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `https://api.moonshot.${region}/v1/users/me/balance`,
  )
})

it("uses OpenRouter's reported remaining key budget instead of deriving account balance from lifetime usage", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        usage: 150,
        limit: 100,
        limit_remaining: 75,
        limit_reset: "monthly",
      },
    }),
  )
  expect(
    (await read(config("openrouter", "https://openrouter.ai/api/v1")))
      .subscription.financials,
  ).toEqual({
    status: "available",
    keyLimitReset: "monthly",
    metrics: [
      { kind: "key_remaining", currency: "USD", amount: 75 },
      { kind: "key_limit", currency: "USD", amount: 100 },
      { kind: "key_usage", currency: "USD", amount: 150 },
    ],
  })
})

it("distinguishes no configured key limit from a zero budget", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ data: { usage: 2, limit: null, limit_remaining: null } }),
    )
  expect(
    (await read(config("openrouter", "https://openrouter.ai/api/v1")))
      .subscription.financials,
  ).toMatchObject({
    status: "available",
    unlimited: true,
    metrics: [{ kind: "key_usage", amount: 2 }],
  })
  fetch.mockResolvedValue(
    Response.json({ data: { usage: 0, limit: 0, limit_remaining: 0 } }),
  )
  expect(
    (await read(config("openrouter", "https://openrouter.ai/api/v1")))
      .subscription.financials,
  ).toMatchObject({
    status: "available",
    metrics: [
      { kind: "key_remaining", amount: 0 },
      { kind: "key_limit", amount: 0 },
      { kind: "key_usage", amount: 0 },
    ],
  })
})

it.each([
  [401, "permission_denied"],
  [403, "permission_denied"],
  [429, "temporarily_unavailable"],
  [500, "temporarily_unavailable"],
])("does not expose HTTP %s failures as a zero balance", async (status, reason) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("private body", { status }),
  )
  expect(
    (await read(config("deepseek", "https://api.deepseek.com"))).subscription
      .financials,
  ).toEqual({ status: "unavailable", reason })
})

it.each([
  {},
  {
    code: 1,
    status: false,
    data: { available_balance: 5, voucher_balance: 5, cash_balance: 0 },
  },
  {
    code: 0,
    status: true,
    data: { available_balance: null, voucher_balance: 5, cash_balance: 0 },
  },
])("rejects malformed or failed financial responses", async (body) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body))
  expect(
    (await read(config("moonshot", "https://api.moonshot.ai/v1"))).subscription
      .financials,
  ).toEqual({ status: "unavailable", reason: "temporarily_unavailable" })
})

it("returns unknown after network or JSON failure without leaking response content", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("private network detail"))
  expect(
    (await read(config("deepseek", "https://api.deepseek.com"))).subscription
      .financials,
  ).toEqual({ status: "unavailable", reason: "temporarily_unavailable" })
  fetch.mockResolvedValue(new Response("secret non-json"))
  expect(
    (await read(config("deepseek", "https://api.deepseek.com"))).subscription
      .financials,
  ).toEqual({ status: "unavailable", reason: "temporarily_unavailable" })
})

it.each([
  ["deepseek", "https://relay.example/v1"],
  ["deepseek", "http://api.deepseek.com"],
  ["deepseek", "https://api.deepseek.com/other"],
  ["deepseek", "https://api.deepseek.com?proxy=1"],
  ["moonshot", "https://api.moonshot.ai.evil.example/v1"],
  ["openrouter", "https://relay.example/api/v1"],
  ["openai", "https://api.openai.com/v1"],
])("never sends %s relay or unsupported keys to official billing endpoints", async (service, baseURL) => {
  const fetch = vi.spyOn(globalThis, "fetch")
  expect(
    (await read(config(service, baseURL))).subscription.financials,
  ).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})

it("does not request balances for disconnected or credential-free accounts", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
  await read(config("deepseek", "https://api.deepseek.com"), false)
  await read({
    ...config("deepseek", "https://api.deepseek.com"),
    authentication: "none",
  })
  expect(fetch).not.toHaveBeenCalled()
})
