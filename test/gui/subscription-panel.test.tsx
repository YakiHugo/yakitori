import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SubscriptionUsageCard } from "../../src/gui/components/subscription-panel.tsx"
import type { ApiSubscriptionSummary } from "../../src/protocol/application.ts"

const subscription: ApiSubscriptionSummary = {
  provider: "deepseek-work",
  displayName: "DeepSeek work",
  availability: "available",
  credentialKind: "api_key",
  usage: { status: "unavailable", reason: "not_supported" },
}

afterEach(cleanup)

function card(summary: ApiSubscriptionSummary) {
  return (
    <SubscriptionUsageCard
      provider={summary.provider}
      displayName={summary.displayName}
      state={{
        subscription: summary,
        loading: false,
        updatedAt: Date.UTC(2026, 10, 8, 12),
      }}
    />
  )
}

describe("account financial reporting", () => {
  it("shows reported currencies and exact amounts without clamping or inventing a quota", () => {
    render(
      card({
        ...subscription,
        financials: {
          status: "available",
          metrics: [
            { kind: "balance", currency: "CNY", amount: -0.25 },
            { kind: "granted_balance", currency: "CNY", amount: 0 },
            { kind: "cash_balance", currency: "CNY", amount: 12.345678 },
            { kind: "balance", currency: "USD", amount: 0.000000001 },
          ],
        },
      }),
    )

    expect(screen.getByText("API key connection")).toBeDefined()
    expect(screen.getAllByText("Account balance")).toHaveLength(2)
    expect(screen.getByText("CNY -0.25")).toBeDefined()
    expect(screen.getByText("CNY 0.00")).toBeDefined()
    expect(screen.getByText("CNY 12.345678")).toBeDefined()
    expect(screen.getByText("USD 0.000000001")).toBeDefined()
    expect(screen.getByText(/^Updated /)).toBeDefined()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
    expect(screen.queryByText(/not supported/)).toBeNull()
  })

  it("labels OpenRouter key budgets separately from the account balance", () => {
    render(
      card({
        ...subscription,
        provider: "router-work",
        displayName: "OpenRouter work",
        financials: {
          status: "available",
          metrics: [
            { kind: "key_remaining", currency: "USD", amount: 0 },
            { kind: "key_limit", currency: "USD", amount: 10 },
            { kind: "key_usage", currency: "USD", amount: 11.25 },
          ],
          keyLimitReset: "monthly",
        },
      }),
    )

    const remaining = screen.getByText("API key remaining budget").parentElement
    if (!remaining) throw new Error("Missing remaining budget row")
    expect(within(remaining).getByText("USD 0.00")).toBeDefined()
    expect(screen.getByText("API key budget")).toBeDefined()
    expect(screen.getByText("API key lifetime usage")).toBeDefined()
    expect(screen.getByText("API key budget resets monthly.")).toBeDefined()
    expect(
      screen.getByText(
        "Account funds and other account or organization limits may still restrict usage.",
      ),
    ).toBeDefined()
    expect(screen.getByText("USD 11.25")).toBeDefined()
    expect(screen.queryByText("Account balance")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("describes an unconfigured key limit without claiming unlimited funds or access", () => {
    render(
      card({
        ...subscription,
        financials: {
          status: "available",
          metrics: [{ kind: "key_usage", currency: "USD", amount: 0.5 }],
          unlimited: true,
        },
      }),
    )

    expect(screen.getByText("No budget limit configured")).toBeDefined()
    expect(
      screen.getByText(
        "This does not mean the account has unlimited funds. Account funds and other account or organization limits may still restrict usage.",
      ),
    ).toBeDefined()
    expect(screen.getByText("USD 0.50")).toBeDefined()
    expect(screen.queryByText("Account balance")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it.each([
    ["temporarily_unavailable", "Could not refresh them."],
    ["permission_denied", "does not have permission"],
  ] as const)("shows %s as unknown instead of a zero balance or an unsupported connection", (reason, message) => {
    const { rerender } = render(
      card({
        ...subscription,
        financials: {
          status: "available",
          metrics: [{ kind: "balance", currency: "CNY", amount: 19 }],
        },
      }),
    )
    expect(screen.getByText("CNY 19.00")).toBeDefined()
    rerender(
      card({
        ...subscription,
        financials: { status: "unavailable", reason },
      }),
    )

    expect(
      screen.getByText(/Balance and budget unknown/).textContent,
    ).toContain(message)
    expect(screen.queryByText("CNY 19.00")).toBeNull()
    expect(screen.queryByText(/0\.00/)).toBeNull()
    expect(screen.queryByText(/not supported/)).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("keeps monetary amounts separate from independently reported subscription quotas", () => {
    render(
      card({
        ...subscription,
        usage: {
          status: "available",
          buckets: [{ name: "Monthly quota", usedPercent: 40 }],
        },
        financials: {
          status: "available",
          metrics: [{ kind: "balance", currency: "USD", amount: 7 }],
        },
      }),
    )

    expect(screen.getByText("USD 7.00")).toBeDefined()
    expect(screen.getAllByRole("progressbar")).toHaveLength(1)
    expect(
      screen.getByRole("progressbar", { name: "Monthly quota: 40% used" }),
    ).toBeDefined()
  })
})
