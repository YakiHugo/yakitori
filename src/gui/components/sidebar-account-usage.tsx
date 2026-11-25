import {
  ArrowUpRight,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
} from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { ApiReadSubscriptionResponse } from "../../protocol/application.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { AccountFinancials } from "./account-financials.tsx"
import { ChatGPTUsageLink } from "./chatgpt-usage-link.tsx"
import { formatPlan, formatResetTime } from "./subscription-panel.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import "./sidebar-account-usage.css"

type UsageResult =
  | (ApiReadSubscriptionResponse & Readonly<{ accountId: string }>)
  | Readonly<{ accountId: string; error: true }>

export function SidebarAccountUsage({
  currentAccountId,
}: Readonly<{ currentAccountId: string | undefined }>) {
  const apiBase = useAppStore((state) => state.apiBase)
  return (
    <AccountUsagePopover
      key={apiBase}
      apiBase={apiBase}
      currentAccountId={currentAccountId}
    />
  )
}

function AccountUsagePopover({
  apiBase,
  currentAccountId,
}: Readonly<{ apiBase: string; currentAccountId: string | undefined }>) {
  const accounts = useAppStore((state) => state.accounts)
  const recentAccountIds = useAppStore(
    (state) => state.usage.summary?.recentAccountIds,
  )
  const loadUsage = useAppStore((state) => state.loadUsage)
  const openSettings = useAppStore((state) => state.openSettings)
  const [open, setOpen] = useState(false)
  const [tooltip, setTooltip] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
  const [viewedId, setViewedId] = useState<string>()
  const [result, setResult] = useState<UsageResult>()
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = accounts.find((account) => account.name === currentAccountId)
  const viewed =
    accounts.find((account) => account.name === viewedId) ?? current
  const requestedId = open ? viewed?.name : tooltip ? current?.name : undefined

  useEffect(() => {
    if (requestedId === undefined) return
    let active = true
    void getAppRpcClient(apiBase)
      .request("subscription/read", { provider: requestedId })
      .then(
        (response) => {
          if (active) setResult({ ...response, accountId: requestedId })
        },
        () => {
          if (active) setResult({ accountId: requestedId, error: true })
        },
      )
    return () => {
      active = false
    }
  }, [apiBase, requestedId])

  const usage = result?.accountId === viewed?.name ? result : undefined
  const subscription =
    usage && "subscription" in usage ? usage.subscription : undefined
  const buckets =
    subscription?.usage.status === "available" ? subscription.usage.buckets : []
  const tightest = buckets.reduce<(typeof buckets)[number] | undefined>(
    (lowest, bucket) =>
      lowest === undefined || bucket.usedPercent > lowest.usedPercent
        ? bucket
        : lowest,
    undefined,
  )
  const currentName = current?.displayName ?? current?.name
  const hasOtherAccounts = accounts.some(
    (account) => account.name !== current?.name,
  )
  const recentRanks = new Map(
    recentAccountIds?.map((accountId, index) => [accountId, index]),
  )
  const accountChoices = showAccounts
    ? accounts.toSorted(
        (a, b) =>
          Number(b.name === current?.name) - Number(a.name === current?.name) ||
          (recentRanks.get(a.name) ?? Infinity) -
            (recentRanks.get(b.name) ?? Infinity) ||
          (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
      )
    : []

  return (
    <>
      <Tooltip open={!open && tooltip} onOpenChange={setTooltip}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="window-rail-button account-usage-trigger"
            aria-label="Account usage"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={id}
            popoverTarget={id}
          >
            <ChartNoAxesColumnIncreasing size={18} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={9}>
          {currentName ?? "Account usage"}
          {tightest && viewed?.name === current?.name
            ? ` · ${remainingPercent(tightest.usedPercent)}% remaining (${tightest.name})`
            : ""}
        </TooltipContent>
      </Tooltip>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-title`}
        className="account-usage-popover"
        onToggle={(event) => {
          const opened = event.currentTarget.matches(":popover-open")
          setOpen(opened)
          setTooltip(false)
          if (!opened) {
            setViewedId(undefined)
            setShowAccounts(false)
          }
        }}
      >
        <header className="account-usage-heading">
          <p>
            {viewed?.name === current?.name && viewed
              ? "Next message"
              : "Account usage"}
          </p>
          <h2 id={`${id}-title`}>
            {viewed?.displayName ?? viewed?.name ?? "Usage limits"}
          </h2>
          {subscription?.plan && (
            <span>{formatPlan(subscription.plan)} plan</span>
          )}
        </header>
        <div className="account-usage-body">
          {!viewed ? (
            <p>
              {accounts.length
                ? "The next account is undetermined."
                : "Connect an account to view its usage."}
            </p>
          ) : viewed.availability === "requires_login" ||
            subscription?.availability === "requires_login" ? (
            <p>Reconnect this account to check its usage.</p>
          ) : !usage ? (
            <p role="status">Checking usage…</p>
          ) : "error" in usage ||
            (subscription?.usage.status === "unavailable" &&
              subscription.usage.reason === "temporarily_unavailable") ? (
            <p role="status">Usage is temporarily unavailable.</p>
          ) : buckets.length === 0 && !subscription?.financials ? (
            <p>
              {subscription?.management === "chatgpt"
                ? "View limits and balances in ChatGPT."
                : "This connection doesn’t report usage limits."}
            </p>
          ) : (
            <>
              {buckets.map((bucket) => {
                const remaining = remainingPercent(bucket.usedPercent)
                const reset =
                  bucket.resetsAt === undefined
                    ? undefined
                    : new Date(bucket.resetsAt)
                return (
                  <div
                    className="account-usage-meter"
                    key={`${bucket.name}-${bucket.resetsAt ?? ""}`}
                  >
                    <div>
                      <span>{bucket.name}</span>
                      <strong>{remaining}% remaining</strong>
                    </div>
                    <progress
                      max={100}
                      value={remaining}
                      aria-label={`${bucket.name} remaining`}
                    />
                    {reset && Number.isFinite(reset.getTime()) && (
                      <time dateTime={reset.toISOString()}>
                        Resets {formatResetTime(reset)}
                      </time>
                    )}
                  </div>
                )
              })}
              {subscription?.financials && (
                <AccountFinancials financials={subscription.financials} />
              )}
            </>
          )}
        </div>
        <footer className="account-usage-actions">
          {hasOtherAccounts && (
            <>
              <button
                type="button"
                aria-expanded={showAccounts}
                aria-controls={showAccounts ? `${id}-accounts` : undefined}
                onClick={() => {
                  if (!showAccounts) void loadUsage()
                  setShowAccounts(!showAccounts)
                }}
              >
                {current ? "Other accounts" : "View accounts"}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {showAccounts && (
                <ul id={`${id}-accounts`} aria-label="Provider accounts">
                  {accountChoices.map((account) => (
                    <li key={account.name}>
                      <button
                        type="button"
                        aria-pressed={account.name === viewed?.name}
                        onClick={() =>
                          setViewedId(
                            account.name === current?.name
                              ? undefined
                              : account.name,
                          )
                        }
                      >
                        {account.displayName ?? account.name}
                        {account.name === current?.name && (
                          <small>Next message</small>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {subscription?.management === "chatgpt" ? (
            <ChatGPTUsageLink />
          ) : (
            <button
              type="button"
              onClick={() => {
                panel.current?.hidePopover()
                openSettings(viewed ? "subscriptions" : "providers")
              }}
            >
              {viewed ? "Manage usage" : "Manage accounts"}
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
        </footer>
      </div>
    </>
  )
}

function remainingPercent(usedPercent: number) {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)))
}
