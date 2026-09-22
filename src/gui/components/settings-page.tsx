import {
  ArrowLeft,
  Bell,
  ChartColumn,
  CircleUserRound,
  LoaderCircle,
  Monitor,
  Plug,
  RefreshCw,
} from "lucide-react"
import { useEffect } from "react"
import { type SettingsSection, useAppStore } from "../store/app-store.ts"
import { McpSettings } from "./mcp-settings.tsx"
import {
  GeneralSettingsSection,
  NotificationSettingsSection,
} from "./settings-panel.tsx"
import { SubscriptionsSection } from "./subscription-panel.tsx"

const sections = [
  { id: "general", label: "General", icon: Monitor },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "subscriptions", label: "Subscriptions", icon: CircleUserRound },
  { id: "mcp", label: "MCP servers", icon: Plug },
  { id: "usage", label: "Usage", icon: ChartColumn },
] as const satisfies readonly Readonly<{
  id: SettingsSection
  label: string
  icon: typeof Monitor
}>[]

const sectionAria: Record<SettingsSection, string> = {
  general: "General settings",
  notifications: "Notification settings",
  subscriptions: "Subscription settings",
  mcp: "MCP server settings",
  usage: "Usage dashboard",
}

export function SettingsPage() {
  const section = useAppStore((state) => state.settingsSection) ?? "general"
  const setSettingsSection = useAppStore((state) => state.setSettingsSection)
  const closeSettings = useAppStore((state) => state.closeSettings)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return
      if (document.querySelector("dialog[open]")) return
      closeSettings()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [closeSettings])

  return (
    <div className="settings-page">
      <aside className="settings-sidebar" aria-label="Settings navigation">
        <button
          type="button"
          className="settings-back"
          aria-label="Back to app"
          title="Back to app (Esc)"
          onClick={closeSettings}
        >
          <ArrowLeft size={16} />
          <span>Back to app</span>
        </button>
        <div className="settings-nav-group">
          <p>Preferences</p>
          <nav aria-label="Settings sections" className="settings-nav">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => setSettingsSection(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>
      <main className="settings-page-body">
        <section className="settings-content" aria-label={sectionAria[section]}>
          <div className="settings-content-inner">
            {section === "general" ? (
              <GeneralSettingsSection />
            ) : section === "notifications" ? (
              <NotificationSettingsSection />
            ) : section === "subscriptions" ? (
              <>
                <div className="settings-section-heading">
                  <CircleUserRound size={22} />
                  <h3>Subscriptions</h3>
                  <p>Connected accounts and their current limits.</p>
                </div>
                <SubscriptionsSection />
              </>
            ) : section === "mcp" ? (
              <McpSettings />
            ) : (
              <UsageSection />
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function UsageSection() {
  const usage = useAppStore((state) => state.usage)
  const loadUsage = useAppStore((state) => state.loadUsage)
  const summary = usage.summary
  const maxDayTokens = Math.max(
    1,
    ...(summary?.days.map((day) => day.inputTokens + day.outputTokens) ?? [1]),
  )
  return (
    <>
      <div className="settings-section-heading settings-usage-heading">
        <ChartColumn size={22} />
        <h3>Usage</h3>
        <p>Token usage recorded by conversations on this device.</p>
        <button
          type="button"
          aria-label="Refresh usage"
          title="Refresh usage"
          disabled={usage.loading}
          onClick={() => void loadUsage()}
        >
          {usage.loading ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
        </button>
      </div>
      {summary === undefined ? (
        <p className="settings-hint" role={usage.error ? "alert" : "status"}>
          {usage.error ??
            (usage.loading ? "Loading usage…" : "Usage has not been loaded.")}
        </p>
      ) : (
        <>
          {usage.error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {usage.error} Showing the previous result.
            </p>
          )}
          <div className="usage-stat-grid">
            <UsageStat
              label="Input tokens"
              value={summary.totals.inputTokens}
            />
            <UsageStat
              label="Output tokens"
              value={summary.totals.outputTokens}
            />
            <UsageStat
              label="Cache read"
              value={summary.totals.cacheReadInputTokens}
            />
            <UsageStat label="Turns" value={summary.totals.turns} />
          </div>
          <h4 className="usage-subheading">Last {summary.days.length} days</h4>
          {summary.days.length === 0 ? (
            <p className="settings-hint">No usage recorded yet.</p>
          ) : (
            <ul className="usage-days">
              {summary.days.map((day) => {
                const total = day.inputTokens + day.outputTokens
                return (
                  <li className="usage-day" key={day.date}>
                    <span className="usage-day-date">{day.date}</span>
                    <span
                      className="usage-day-bar"
                      style={{
                        inlineSize: `${Math.max(2, (total / maxDayTokens) * 100)}%`,
                      }}
                    />
                    <span className="usage-day-value">
                      {formatTokens(total)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <h4 className="usage-subheading">Top conversations</h4>
          {summary.threads.length === 0 ? (
            <p className="settings-hint">No conversations recorded yet.</p>
          ) : (
            <table className="usage-threads">
              <thead>
                <tr>
                  <th>Conversation</th>
                  <th>Turns</th>
                  <th>Input</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {summary.threads.map((thread) => (
                  <tr key={thread.threadId}>
                    <td>{thread.title || thread.threadId}</td>
                    <td>{thread.turns}</td>
                    <td>{formatTokens(thread.inputTokens)}</td>
                    <td>{formatTokens(thread.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  )
}

function UsageStat({
  label,
  value,
}: Readonly<{ label: string; value: number }>) {
  return (
    <div className="usage-stat">
      <strong>{formatTokens(value)}</strong>
      <span>{label}</span>
    </div>
  )
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value)
}
