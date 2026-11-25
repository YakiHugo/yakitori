import { useTranslation } from "../i18n/use-translation.ts"
import type {
  ApiSubscriptionProvider,
  ApiSubscriptionSummary,
} from "../../protocol/application.ts"
import type { Locale } from "../i18n/locale.ts"
import { type Translate, translators } from "../i18n/messages.ts"
import { useAppStore, type SubscriptionUsageState } from "../store/app-store.ts"
import { AccountFinancials } from "./account-financials.tsx"

export function SubscriptionsSection() {
  const { t } = useTranslation()
  const states = useAppStore((state) => state.subscriptionsByProvider)
  const error = useAppStore((state) => state.subscriptionsError)
  return (
    <div className="subscription-list">
      {error ? <p role="alert">{error}</p> : null}
      {!error && Object.keys(states).length === 0 ? (
        <p className="subscription-note">
          {t(
            "Add an account in Providers to view its balance or subscription limits.",
          )}
        </p>
      ) : null}
      {Object.keys(states).map((provider) => (
        <ProviderUsageCard
          key={provider}
          provider={provider}
          displayName={
            states[provider]?.subscription?.displayName ?? t("Account usage")
          }
        />
      ))}
    </div>
  )
}

function ProviderUsageCard({
  provider,
  displayName,
}: Readonly<{
  provider: ApiSubscriptionProvider
  displayName: string
}>) {
  const state = useAppStore((store) => store.subscriptionsByProvider[provider])
  if (!state) return null
  return (
    <SubscriptionUsageCard
      provider={provider}
      displayName={displayName}
      state={state}
    />
  )
}

export function SubscriptionUsageCard({
  provider,
  displayName,
  state,
}: Readonly<{
  provider: string
  displayName: string
  state: SubscriptionUsageState
}>) {
  const { locale, t } = useTranslation()
  const summary = state.subscription
  const firstLoad = summary === undefined

  return (
    <section
      className="subscription-card"
      aria-labelledby={`${provider}-usage`}
      aria-busy={state.loading}
    >
      <div className="subscription-card-header">
        <div>
          <h3 id={`${provider}-usage`}>{displayName}</h3>
          {summary ? <p>{accountLabel(summary, t)}</p> : null}
        </div>
      </div>

      {firstLoad && state.loading ? (
        <SubscriptionSkeleton />
      ) : summary === undefined ? (
        <p
          className="subscription-note"
          role={state.error ? "alert" : undefined}
        >
          {state.error ?? t("Usage has not been checked yet.")}
        </p>
      ) : (
        <>
          <ProviderUsage provider={summary} />
          {state.error === undefined ? null : (
            <p className="subscription-card-error" role="alert">
              {state.error} {t("Showing the previous result.")}
            </p>
          )}
          {state.updatedAt === undefined ? null : (
            <p className="subscription-card-updated">
              {t("Updated")} {formatUpdatedAt(state.updatedAt, locale)}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function ProviderUsage({
  provider,
}: Readonly<{ provider: ApiSubscriptionSummary }>) {
  const { locale, t } = useTranslation()
  const connected = provider.availability === "available"
  const usage = provider.usage
  const financials = provider.financials ? (
    <div className="mt-4">
      <AccountFinancials financials={provider.financials} />
    </div>
  ) : null
  if (!connected) {
    return (
      <p className="subscription-note">
        {t(
          "Sign in or configure this provider to view its subscription status.",
        )}
      </p>
    )
  }
  if (usage.status !== "available") {
    return (
      financials ?? (
        <p className="subscription-note">
          {usage.reason === "temporarily_unavailable"
            ? t("Usage could not be refreshed. Try again in a moment.")
            : provider.credentialKind === "api_key"
              ? t(
                  "Balance and usage reporting is not supported for this connection.",
                )
              : t(
                  "This provider does not currently expose subscription limits here.",
                )}
        </p>
      )
    )
  }
  if (usage.buckets.length === 0) {
    return (
      financials ?? (
        <p className="subscription-note">
          {t("No usage limits were reported.")}
        </p>
      )
    )
  }
  return (
    <>
      {financials}
      <div className="subscription-buckets">
        {usage.buckets.map((bucket) => {
          const percent = Math.max(0, Math.min(100, bucket.usedPercent))
          const nearLimit = percent >= 90
          const reset = validDate(bucket.resetsAt)
          return (
            <div
              className="subscription-bucket"
              key={`${bucket.name}-${bucket.resetsAt ?? "no-reset"}`}
            >
              <div className="subscription-bucket-label">
                <span>{bucket.name}</span>
                <strong>
                  {Math.round(bucket.usedPercent)}
                  {t("% used")}
                  {nearLimit ? ` ${t("· Near limit")}` : ""}
                </strong>
              </div>
              <progress
                className="subscription-progress"
                data-near-limit={nearLimit}
                max={100}
                value={percent}
                aria-label={t(
                  "{0}: {1}% used",
                  bucket.name,
                  Math.round(bucket.usedPercent),
                )}
              />
              {reset === undefined ? null : (
                <time
                  className="subscription-reset"
                  dateTime={reset.toISOString()}
                >
                  {t("Resets")} {formatResetTime(reset, locale)}
                </time>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function SubscriptionSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="subscription-skeleton" role="status">
      <span className="sr-only">{t("Loading usage")}</span>
      <span className="subscription-skeleton-label" />
      <span className="subscription-skeleton-progress" />
    </div>
  )
}

function accountLabel(provider: ApiSubscriptionSummary, t: Translate): string {
  return provider.plan === undefined
    ? provider.credentialKind === "api_key"
      ? t("API key connection")
      : t("Subscription account")
    : t("{0} plan", formatPlan(provider.plan))
}

export function formatPlan(plan: string): string {
  const known = {
    prolite: "Pro Lite",
    self_serve_business_prolite: "Business Pro Lite",
    self_serve_business_usage_based: "Business Usage Based",
    enterprise_cbp_automation: "Enterprise Automation",
    enterprise_cbp_usage_based: "Enterprise Usage Based",
  } as const
  if (Object.hasOwn(known, plan)) return known[plan as keyof typeof known]
  return plan
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function formatUpdatedAt(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp)
}

function validDate(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined) return
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date : undefined
}

export function formatResetTime(reset: Date, locale: Locale): string {
  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)
  if (reset.toDateString() === now.toDateString()) {
    const t = translators[locale]
    return t("today at {0}", time)
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)
}
