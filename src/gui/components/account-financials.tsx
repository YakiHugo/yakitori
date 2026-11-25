import { useTranslation } from "../i18n/use-translation.ts"
import type { ApiAccountFinancials } from "../../protocol/application.ts"

const amountFormat = new Intl.NumberFormat("en", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 20,
})

const metricLabels = {
  balance: "Account balance",
  granted_balance: "Granted balance",
  cash_balance: "Cash balance",
  key_remaining: "API key remaining budget",
  key_limit: "API key budget",
  key_usage: "API key lifetime usage",
} as const

export function AccountFinancials({
  financials,
}: Readonly<{
  financials: ApiAccountFinancials
}>) {
  const { t } = useTranslation()
  if (financials.status === "unavailable") {
    return (
      <p className="text-xs text-muted-foreground">
        {t("Balance and budget unknown.")}{" "}
        {financials.reason === "permission_denied"
          ? t("This connection does not have permission to read them.")
          : t("Could not refresh them. Try again in a moment.")}
      </p>
    )
  }
  return (
    <div className="space-y-2 text-xs">
      <dl className="space-y-2">
        {financials.metrics.map((metric) => (
          <div
            key={`${metric.kind}-${metric.currency}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
          >
            <dt className="text-muted-foreground">
              {metricLabels[metric.kind]}
            </dt>
            <dd className="font-medium tabular-nums">
              {metric.currency} {amountFormat.format(metric.amount)}
            </dd>
          </div>
        ))}
        {financials.unlimited ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("API key budget")}</dt>
            <dd className="font-medium">{t("No budget limit configured")}</dd>
          </div>
        ) : null}
      </dl>
      {financials.keyLimitReset ? (
        <p className="text-muted-foreground">
          {t("API key budget resets")} {financials.keyLimitReset}.
        </p>
      ) : null}
      {financials.unlimited ||
      financials.metrics.some((metric) => metric.kind.startsWith("key_")) ? (
        <p className="text-muted-foreground">
          {financials.unlimited
            ? `${t("This does not mean the account has unlimited funds.")} `
            : ""}
          {t(
            "Account funds and other account or organization limits may still restrict usage.",
          )}
        </p>
      ) : null}
      {financials.metrics.length === 0 && !financials.unlimited ? (
        <p className="text-muted-foreground">
          {t("No balance or budget was reported.")}
        </p>
      ) : null}
    </div>
  )
}
