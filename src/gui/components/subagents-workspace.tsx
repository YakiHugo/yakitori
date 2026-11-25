import { useTranslation } from "../i18n/use-translation.ts"
import { ChevronRight, RefreshCw, Users } from "lucide-react"
import {
  agentStatusLabel,
  useSessionAgents,
} from "../hooks/use-session-agents.ts"
import { SubagentPanel } from "./subagent-panel.tsx"
import "./subagents-workspace.css"

export function SubagentsWorkspace({
  sourceSessionId,
  selectedAgentId,
  apiBase,
  active,
  onSelect,
}: Readonly<{
  sourceSessionId: string | undefined
  selectedAgentId: string | undefined
  apiBase: string
  active: boolean
  onSelect(agentId?: string): void
}>) {
  const { t } = useTranslation()
  const { agents, loading, error, refresh } = useSessionAgents(
    apiBase,
    sourceSessionId,
    active && !selectedAgentId,
  )
  const workingCount = agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending_init",
  ).length
  if (selectedAgentId)
    return (
      <SubagentPanel
        key={`${apiBase}:${selectedAgentId}`}
        sessionId={selectedAgentId}
        apiBase={apiBase}
        active={active}
        onBack={() => onSelect()}
        onOpenAgent={onSelect}
      />
    )
  return (
    <section className="subagents-workspace" aria-label={t("Subagents")}>
      <header className="subagents-list-heading">
        <div>
          <Users size={17} />
          <h2>{t("Subagents")}</h2>
          {agents.length > 0 ? <span>{agents.length}</span> : null}
        </div>
        <button
          type="button"
          className="sidebar-icon"
          aria-label={t("Refresh subagents")}
          disabled={loading || !sourceSessionId}
          onClick={refresh}
        >
          <RefreshCw
            size={14}
            className={loading ? "animate-spin" : undefined}
          />
        </button>
      </header>
      {!sourceSessionId ? (
        <p className="subagents-list-empty">
          {t("Open a conversation to view its subagents.")}
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="subagents-list-error">
              {error}
            </p>
          )}
          {loading && agents.length === 0 ? (
            <p role="status" className="subagents-list-empty">
              {t("Loading subagents…")}
            </p>
          ) : agents.length === 0 && !error ? (
            <div className="subagents-list-empty">
              <Users size={26} strokeWidth={1.25} />
              <p>{t("No delegated tasks yet.")}</p>
              <p>
                {t(
                  "Subagents will appear here when this conversation delegates work.",
                )}
              </p>
            </div>
          ) : (
            <>
              <p className="subagents-list-caption">
                {workingCount > 0
                  ? `${workingCount} ${workingCount === 1 ? "agent" : "agents"} working`
                  : t("Delegated work")}
                <span>{t("Open an agent to follow its progress.")}</span>
              </p>
              <ul className="subagents-list" aria-label={t("Delegated agents")}>
                {agents.map((agent) => {
                  const status = agentStatusLabel(agent.status)
                  return (
                    <li key={agent.agentId}>
                      <button
                        type="button"
                        onClick={() => onSelect(agent.agentId)}
                        aria-label={t("View {0} trace", agent.taskName)}
                      >
                        <span
                          className="subagent-status-dot"
                          data-status={status}
                        />
                        <span className="subagent-list-name">
                          <strong title={agent.taskName}>
                            {agent.taskName}
                          </strong>
                          <small title={agent.path}>{agent.path}</small>
                        </span>
                        <span
                          className="subagent-list-status"
                          data-status={status}
                        >
                          {status}
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
