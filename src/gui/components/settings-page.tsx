import {
  ArrowLeft,
  Bell,
  ChartColumn,
  CircleUserRound,
  Cpu,
  Monitor,
  Plug,
  Server,
} from "lucide-react"
import { useEffect } from "react"
import { type SettingsSection, useAppStore } from "../store/app-store.ts"
import { McpSettings } from "./mcp-settings.tsx"
import {
  GeneralSettingsSection,
  NotificationSettingsSection,
} from "./settings-panel.tsx"
import { UsageSection } from "./usage-section.tsx"
import { SubscriptionsSection } from "./subscription-panel.tsx"
import { ProviderSettings } from "./provider-settings.tsx"
import { RuntimeSettings } from "./runtime-settings.tsx"

const sections = [
  { id: "general", label: "General", icon: Monitor },
  { id: "runtime", label: "Runtime", icon: Cpu },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "providers", label: "Providers", icon: Server },
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
  runtime: "Runtime settings",
  notifications: "Notification settings",
  providers: "Provider settings",
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
      if (event.defaultPrevented || event.key !== "Escape" || event.isComposing)
        return
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
      <main
        className={`settings-page-body${section === "providers" ? " settings-provider-body" : ""}`}
      >
        {section === "providers" ? (
          <ProviderSettings />
        ) : (
          <section
            className="settings-content"
            aria-label={sectionAria[section]}
          >
            <div className="settings-content-inner">
              {section === "general" ? (
                <GeneralSettingsSection />
              ) : section === "runtime" ? (
                <RuntimeSettings />
              ) : section === "notifications" ? (
                <NotificationSettingsSection />
              ) : section === "subscriptions" ? (
                <SubscriptionsSection />
              ) : section === "mcp" ? (
                <McpSettings />
              ) : (
                <UsageSection />
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
