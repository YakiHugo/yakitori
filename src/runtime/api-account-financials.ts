import type { ApiAccountFinancials } from "../protocol/application.ts"
import type { ProviderConfiguration } from "../protocol/providers.ts"

// Only explicitly supported official endpoints may receive a configured key.
// A relay using the same service name must never send its key to the vendor.
export function accountFinancialEndpoint(config: ProviderConfiguration):
  | {
      url: string
      kind: "deepseek" | "moonshot" | "openrouter"
      currency?: string
    }
  | undefined {
  if (
    config.authentication !== "stored" &&
    config.authentication !== "environment"
  )
    return
  const base = new URL(config.baseURL)
  if (base.username || base.password || base.search || base.hash) return
  const url = base.href.replace(/\/$/, "")
  if (
    config.service === "deepseek" &&
    ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(url)
  )
    return { kind: "deepseek", url: "https://api.deepseek.com/user/balance" }
  if (config.service === "moonshot") {
    if (url === "https://api.moonshot.ai/v1")
      return {
        kind: "moonshot",
        url: `${url}/users/me/balance`,
        currency: "USD",
      }
    if (url === "https://api.moonshot.cn/v1")
      return {
        kind: "moonshot",
        url: `${url}/users/me/balance`,
        currency: "CNY",
      }
  }
  if (config.service === "openrouter" && url === "https://openrouter.ai/api/v1")
    return { kind: "openrouter", url: `${url}/key` }
}

type Endpoint = NonNullable<ReturnType<typeof accountFinancialEndpoint>>
type Available = Extract<ApiAccountFinancials, { status: "available" }>

class InvalidFinancialResponse extends Error {}

export async function readApiAccountFinancials(
  endpoint: Endpoint,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ApiAccountFinancials> {
  try {
    const response = await fetchFn(endpoint.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      redirect: "error",
      // UI refresh safety boundary, not a provider quota.
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok)
      return {
        status: "unavailable",
        reason:
          response.status === 401 || response.status === 403
            ? "permission_denied"
            : "temporarily_unavailable",
      }
    return parseFinancials(endpoint, await response.json())
  } catch (error) {
    if (
      !(
        error instanceof InvalidFinancialResponse ||
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        (error instanceof DOMException &&
          ["AbortError", "TimeoutError"].includes(error.name))
      )
    )
      throw error
    return { status: "unavailable", reason: "temporarily_unavailable" }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidFinancialResponse()
  return value as Record<string, unknown>
}

function amount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : NaN
  if (!Number.isFinite(parsed)) throw new InvalidFinancialResponse()
  return parsed
}

function parseFinancials(endpoint: Endpoint, value: unknown): Available {
  const body = record(value)
  // https://api-docs.deepseek.com/api/get-user-balance/
  if (endpoint.kind === "deepseek") {
    if (!Array.isArray(body.balance_infos) || body.balance_infos.length === 0)
      throw new InvalidFinancialResponse()
    return {
      status: "available",
      metrics: body.balance_infos.flatMap((entry) => {
        const row = record(entry)
        if (row.currency !== "CNY" && row.currency !== "USD")
          throw new InvalidFinancialResponse()
        return (
          [
            ["balance", "total_balance"],
            ["granted_balance", "granted_balance"],
            ["cash_balance", "topped_up_balance"],
          ] as const
        ).map(([kind, field]) => ({
          kind,
          currency: row.currency as string,
          amount: amount(row[field]),
        }))
      }),
    }
  }
  const data = record(body.data)
  // https://platform.kimi.ai/docs/api/balance (USD); .com counterpart (CNY).
  if (endpoint.kind === "moonshot") {
    if (body.status !== true || body.code !== 0)
      throw new InvalidFinancialResponse()
    return {
      status: "available",
      metrics: (
        [
          ["balance", "available_balance"],
          ["granted_balance", "voucher_balance"],
          ["cash_balance", "cash_balance"],
        ] as const
      ).map(([kind, field]) => ({
        kind,
        currency: endpoint.currency as string,
        amount: amount(data[field]),
      })),
    }
  }
  // https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
  // These are this key's budget/usage, never the organization's credit balance.
  const metrics: Available["metrics"][number][] = [
    { kind: "key_usage", currency: "USD", amount: amount(data.usage) },
  ]
  if (data.limit === null)
    return { status: "available", metrics, unlimited: true }
  metrics.unshift(
    {
      kind: "key_remaining",
      currency: "USD",
      amount: amount(data.limit_remaining),
    },
    { kind: "key_limit", currency: "USD", amount: amount(data.limit) },
  )
  const keyLimitReset = data.limit_reset
  return {
    status: "available",
    metrics,
    ...(keyLimitReset === "daily" ||
    keyLimitReset === "weekly" ||
    keyLimitReset === "monthly"
      ? { keyLimitReset }
      : {}),
  }
}
