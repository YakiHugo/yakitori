import {
  ChartColumn,
  Check,
  CircleUserRound,
  LoaderCircle,
  Settings2,
  Unplug,
} from "lucide-react"
import { useEffect, useState } from "react"
import type {
  ApiSubscriptionProvider,
  ApiSubscriptionSummary,
} from "../../server/protocol.ts"
import { useAppStore } from "../store/app-store.ts"

const subscriptionProviderNames = new Set(["codex", "grok", "kimi"])
const subscriptionProviders = [
  { provider: "codex", displayName: "Codex" },
  { provider: "grok", displayName: "Grok" },
  { provider: "kimi", displayName: "Kimi" },
] as const satisfies readonly Readonly<{
  provider: ApiSubscriptionProvider
  displayName: string
}>[]

export function SubscriptionPanelButton() {
  const openSettings = useAppStore((state) => state.openSettings)
  const loadSubscriptions = useAppStore((state) => state.loadSubscriptions)
  const subscriptions = useAppStore((state) => state.subscriptionsByProvider)
  const [open, setOpen] = useState(false)
  const connected = useAppStore(
    (state) =>
      state.providers.filter(
        (provider) =>
          subscriptionProviderNames.has(provider.name) &&
          provider.availability === "available",
      ).length,
  )
  const primary = subscriptionProviders
    .map(({ provider }) => subscriptions[provider].subscription)
    .find((summary) => summary?.availability === "available")
  const primaryBucket =
    primary?.usage.status === "available" ? primary.usage.buckets[0] : undefined

  // The menu surfaces live quota, so refresh it on every open.
  useEffect(() => {
    if (open) void loadSubscriptions()
  }, [open, loadSubscriptions])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "," ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return
      event.preventDefault()
      useAppStore.getState().openSettings()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const openSection = (section: "general" | "subscriptions") => {
    setOpen(false)
    openSettings(section)
  }
  return (
    <div className="sidebar-account">
      {open ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-10"
          onClick={() => setOpen(false)}
        />
      ) : null}
      {open ? (
        <div role="menu" aria-label="Account" className="account-menu">
          <div className="account-menu-header">
            <span className="sidebar-account-avatar" aria-hidden="true">
              <CircleUserRound size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <strong>
                {primary === undefined
                  ? "No account"
                  : (subscriptionProviders.find(
                      (entry) => entry.provider === primary.provider,
                    )?.displayName ?? primary.provider)}
              </strong>
              <small>
                {primary === undefined ? "" : accountLabel(primary)}
              </small>
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="account-menu-item"
            onClick={() => openSection("subscriptions")}
          >
            <ChartColumn size={15} className="account-menu-icon" />
            <span className="flex-1 text-left">Usage</span>
            {primaryBucket === undefined ? null : (
              <small className="account-menu-meta">
                {Math.max(0, 100 - Math.round(primaryBucket.usedPercent))}% left
              </small>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-menu-item"
            onClick={() => openSection("general")}
          >
            <Settings2 size={15} className="account-menu-icon" />
            <span className="flex-1 text-left">Settings</span>
            <kbd className="account-menu-meta">⌘ ,</kbd>
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="sidebar-account-trigger"
        aria-label="Open account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-account-avatar" aria-hidden="true">
          <CircleUserRound size={17} />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <strong>Subscriptions</strong>
          <small>
            {connected === 0
              ? "No accounts connected"
              : `${connected} connected`}
          </small>
        </span>
        <span
          className="size-1.5 rounded-full bg-emerald-500"
          aria-hidden="true"
          data-visible={connected > 0}
        />
      </button>
    </div>
  )
}

export function SubscriptionsSection() {
  return (
    <>
      <div className="subscription-intro">
        <p>Subscription access and current limits from connected providers.</p>
        <span>Usage refreshes each time this section opens.</span>
      </div>

      <div className="subscription-list">
        {subscriptionProviders.map((provider) => (
          <ProviderUsageCard key={provider.provider} {...provider} />
        ))}
      </div>
    </>
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
  const summary = state.subscription
  const firstLoad = summary === undefined

  return (
    <section
      className="subscription-card"
      aria-labelledby={`${provider}-usage`}
      aria-busy={state.loading}
      data-loading={state.loading}
    >
      <div className="subscription-card-header">
        <div>
          <h3 id={`${provider}-usage`}>{displayName}</h3>
          <p>
            {summary === undefined
              ? "Subscription account"
              : accountLabel(summary)}
          </p>
        </div>
        {state.loading ? (
          <span className="subscription-status" data-loading="true">
            <LoaderCircle className="subscription-spinner" size={12} />
            {firstLoad ? "Checking" : "Updating"}
          </span>
        ) : summary === undefined ? (
          <span className="subscription-status">
            <Unplug size={12} />
            Unavailable
          </span>
        ) : (
          <ConnectionStatus provider={summary} />
        )}
      </div>

      {firstLoad && state.loading ? (
        <SubscriptionSkeleton />
      ) : summary === undefined ? (
        <p
          className="subscription-note"
          role={state.error ? "alert" : undefined}
        >
          {state.error ?? "Usage has not been checked yet."}
        </p>
      ) : (
        <>
          <ProviderUsage provider={summary} />
          {state.error === undefined ? null : (
            <p className="subscription-card-error" role="alert">
              {state.error} Showing the previous result.
            </p>
          )}
          {state.updatedAt === undefined ? null : (
            <p className="subscription-card-updated">
              Updated {formatUpdatedAt(state.updatedAt)}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function ConnectionStatus({
  provider,
}: Readonly<{ provider: ApiSubscriptionSummary }>) {
  const connected = provider.availability === "available"
  return (
    <span className="subscription-status" data-connected={connected}>
      {connected ? <Check size={12} /> : <Unplug size={12} />}
      {connected
        ? provider.credentialKind === "api_key"
          ? "API key connected"
          : "Connected"
        : "Not connected"}
    </span>
  )
}

function ProviderUsage({
  provider,
}: Readonly<{ provider: ApiSubscriptionSummary }>) {
  const connected = provider.availability === "available"
  const usage = provider.usage
  if (!connected) {
    return (
      <p className="subscription-note">
        Sign in or configure this provider to view its subscription status.
      </p>
    )
  }
  if (usage.status !== "available") {
    return (
      <p className="subscription-note">
        {usage.reason === "temporarily_unavailable"
          ? "Usage could not be refreshed. Try again in a moment."
          : provider.credentialKind === "api_key"
            ? "Subscription usage is not available for API key connections."
            : "This provider does not currently expose subscription limits here."}
      </p>
    )
  }
  if (usage.buckets.length === 0) {
    return <p className="subscription-note">No usage limits were reported.</p>
  }
  return (
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
                {Math.round(bucket.usedPercent)}% used
                {nearLimit ? " · Near limit" : ""}
              </strong>
            </div>
            <progress
              className="subscription-progress"
              data-near-limit={nearLimit}
              max={100}
              value={percent}
              aria-label={`${bucket.name}: ${Math.round(bucket.usedPercent)}% used`}
            />
            {reset === undefined ? null : (
              <time
                className="subscription-reset"
                dateTime={reset.toISOString()}
              >
                Resets {formatResetTime(reset)}
              </time>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SubscriptionSkeleton() {
  return (
    <div className="subscription-skeleton" role="status">
      <span className="sr-only">Loading usage</span>
      <span className="subscription-skeleton-label" />
      <span className="subscription-skeleton-progress" />
    </div>
  )
}

function accountLabel(provider: ApiSubscriptionSummary): string {
  return provider.plan === undefined
    ? provider.credentialKind === "api_key"
      ? "API key connection"
      : "Subscription account"
    : `${formatPlan(provider.plan)} plan`
}

function formatPlan(plan: string): string {
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

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp)
}

function validDate(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined) return
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function formatResetTime(reset: Date): string {
  const now = new Date()
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)
  if (reset.toDateString() === now.toDateString()) return `today at ${time}`
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset)
}
