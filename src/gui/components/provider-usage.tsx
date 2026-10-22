import { useEffect, useState } from "react"
import type { ApiConfiguredProvider } from "../../protocol/providers.ts"
import { estimateModelCost } from "../provider-usage-view.ts"
import { useAppStore, type SubscriptionUsageState } from "../store/app-store.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { ChatGPTUsageLink } from "./chatgpt-usage-link.tsx"
import { totalTokens, type UsageRange, usageView } from "../usage-view.ts"
import { ProviderLogo } from "./provider-logo.tsx"
import { SubscriptionUsageCard } from "./subscription-panel.tsx"

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const currency = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
})

export function ProviderUsage({
  apiBase,
  accountId,
  name,
  configuration,
  chatGPT,
}: Readonly<{
  apiBase: string
  accountId: string
  name: string
  configuration?: ApiConfiguredProvider
  chatGPT: boolean
}>) {
  const usage = useAppStore((state) => state.usage)
  const loadUsage = useAppStore((state) => state.loadUsage)
  const [subscription, setSubscription] = useState<SubscriptionUsageState>({
    loading: true,
  })
  const [range, setRange] = useState<UsageRange>(30)
  useEffect(() => {
    void loadUsage()
  }, [loadUsage])
  useEffect(() => {
    if (chatGPT) return
    let current = true
    void getAppRpcClient(apiBase)
      .request("subscription/read", { provider: accountId })
      .then(
        (response) => {
          if (current)
            setSubscription({
              loading: false,
              subscription: response.subscription,
              updatedAt: response.fetchedAt,
            })
        },
        () => {
          if (current)
            setSubscription({
              loading: false,
              error: "Could not update this account's subscription usage.",
            })
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, accountId, chatGPT])
  const view = usage.summary && usageView(usage.summary, range)
  const rows =
    view?.models
      .filter((row) => row.provider === accountId)
      .map((row) => {
        const provider = configuration
        const model = {
          ...provider?.catalog?.models.find((entry) => entry.id === row.model),
          ...provider?.configuration.models.find(
            (entry) => entry.id === row.model,
          ),
        }
        return {
          ...row,
          sourceName: name,
          preset: provider?.configuration.preset,
          displayName: model.displayName ?? row.model,
          cost: estimateModelCost(row, model.pricing),
        }
      }) ?? []
  const knownCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  const unknown = rows.filter((row) => row.cost === undefined).length
  return (
    <section aria-label="Provider usage">
      <div className="provider-usage-toolbar">
        <h3>Usage</h3>
        <select
          aria-label="Usage period"
          value={range}
          onChange={(event) =>
            setRange(
              event.target.value === "all"
                ? "all"
                : (Number(event.target.value) as UsageRange),
            )
          }
        >
          {([7, 30, 90, 366, "all"] as const).map((value) => (
            <option value={value} key={value}>
              {value === "all" ? "All time" : `Last ${value} days`}
            </option>
          ))}
        </select>
      </div>
      <p className="provider-field-hint">
        Recorded in Yakitori ·{" "}
        {compact.format(
          view ? rows.reduce((sum, row) => sum + totalTokens(row), 0) : 0,
        )}{" "}
        tokens ·{" "}
        {rows.length && unknown !== rows.length
          ? `${unknown ? "At least " : ""}${currency.format(knownCost)} estimated`
          : "Cost unknown"}
      </p>
      {usage.error ? (
        <p role="alert" className="provider-message">
          {usage.error}
        </p>
      ) : null}
      {usage.loading && !view ? (
        <p role="status" className="provider-message">
          Loading usage…
        </p>
      ) : view && !rows.length ? (
        <p className="provider-message">No recorded usage in this period.</p>
      ) : null}
      {rows.length ? (
        <div className="provider-usage-scroll">
          <table className="provider-usage-table">
            <thead>
              <tr>
                <th>Source / model</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache read</th>
                <th>Turns</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={JSON.stringify([row.provider, row.model])}>
                  <td>
                    <div className="provider-usage-source">
                      <ProviderLogo preset={row.preset} />
                      <span>
                        {row.sourceName}
                        <small>{row.displayName}</small>
                      </span>
                    </div>
                  </td>
                  <td>{compact.format(row.inputTokens)}</td>
                  <td>{compact.format(row.outputTokens)}</td>
                  <td>{compact.format(row.cacheReadInputTokens)}</td>
                  <td>{row.turns}</td>
                  <td>
                    {row.cost === undefined ? "—" : currency.format(row.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="provider-message provider-field-hint">
        Estimates use current catalog or custom USD rates, not invoices. “—”
        means pricing is unavailable.
      </p>
      <div className="provider-usage-limits">
        <h4>Subscription limits</h4>
        {chatGPT ? (
          <ChatGPTUsageLink />
        ) : (
          <SubscriptionUsageCard
            provider={accountId}
            displayName={name}
            state={subscription}
          />
        )}
      </div>
    </section>
  )
}
