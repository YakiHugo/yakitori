import { translate, useTranslation } from "../i18n/use-translation.ts"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { SessionHistoryResponse } from "../../protocol/rpc-methods.ts"
import {
  createExecutionViewState,
  type ExecutionViewState,
  prependExecutionHistory,
  projectExecutionView,
} from "../execution-view.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { type HistoryMatch, useAppStore } from "../store/app-store.ts"
import { ConversationMessages } from "./conversation-messages.tsx"
import { ConversationScopeContext } from "./conversation-scope.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"

export function HistoryMatchDialog() {
  const match = useAppStore((state) => state.historyMatch)
  const apiBase = useAppStore((state) => state.apiBase)
  if (match === undefined) return null
  return (
    <HistoryMatchPage
      key={JSON.stringify([apiBase, match.sessionId, match.location])}
      match={match}
      apiBase={apiBase}
    />
  )
}

function HistoryMatchPage({
  match,
  apiBase,
}: Readonly<{ match: HistoryMatch; apiBase: string }>) {
  const { t } = useTranslation()
  const { sessionId, location } = match
  const [position, setPosition] = useState<
    Readonly<{ before?: number; after?: number }>
  >({})
  const [page, setPage] = useState<SessionHistoryResponse>()
  const [execution, setExecution] = useState<ExecutionViewState>()
  const [error, setError] = useState<string>()
  const viewport = useRef<HTMLDivElement>(null)
  const requestVersion = useRef(0)
  const close = () => useAppStore.setState({ historyMatch: undefined })
  useEffect(() => {
    const revision = ++requestVersion.current
    setPage(undefined)
    setExecution(undefined)
    setError(undefined)
    void getAppRpcClient(apiBase)
      .request("session/history", { sessionId, location, ...position })
      .then(
        (response) => {
          if (requestVersion.current !== revision) return
          setPage(response)
          const view = prependExecutionHistory(
            createExecutionViewState(),
            response.events,
          )
          setExecution({
            ...view,
            deferredTurnActivity: Object.fromEntries(
              (response.activityTurnIds ?? []).map((id) => [id, "unloaded"]),
            ),
          })
        },
        (cause: unknown) => {
          if (requestVersion.current !== revision) return
          setError(
            cause instanceof Error
              ? cause.message
              : translate("Could not load this part of the conversation."),
          )
        },
      )
    return () => {
      requestVersion.current++
    }
  }, [apiBase, sessionId, location, position])

  useLayoutEffect(() => {
    if (page === undefined) return
    const content = viewport.current
    if (content === null) return
    const anchor =
      position.before === undefined && position.after === undefined
        ? content.querySelector(
            `[data-context-message-id="${CSS.escape(location.itemId)}"]`,
          )
        : undefined
    if (!(anchor instanceof HTMLElement)) {
      content.scrollTop =
        position.after === undefined ? 0 : content.scrollHeight
      return
    }
    anchor.setAttribute("data-find-current", "")
    anchor.setAttribute("data-find-fallback", "")
    anchor.scrollIntoView({ block: "center" })
    return () => {
      anchor.removeAttribute("data-find-current")
      anchor.removeAttribute("data-find-fallback")
    }
  }, [location.itemId, page, position])

  const loadTurnActivity = useCallback(
    async (turnId: string) => {
      const before = execution?.deferredTurnActivity[turnId]
      if (before === undefined || before === "loaded") return
      const revision = requestVersion.current
      const response = await getAppRpcClient(apiBase).request(
        "session/activity/read",
        {
          sessionId,
          rolloutId: location.rolloutId,
          turnId,
          ...(before === "unloaded" ? {} : { before }),
        },
      )
      if (requestVersion.current !== revision) return
      setExecution((current) =>
        current === undefined
          ? undefined
          : {
              ...prependExecutionHistory(current, response.events),
              deferredTurnActivity: {
                ...current.deferredTurnActivity,
                [turnId]: response.nextBefore ?? "loaded",
              },
            },
      )
    },
    [apiBase, execution?.deferredTurnActivity, location.rolloutId, sessionId],
  )

  const earlier = page?.historyBefore
  const later = page?.historyAfter
  return (
    <SidebarDialog
      title={match.title ?? t("Conversation history")}
      onClose={close}
      className="!w-[min(54rem,92vw)]"
    >
      <div className="max-h-[65vh] overflow-auto px-2" ref={viewport}>
        {error === undefined ? (
          execution === undefined ? (
            <p role="status" className="py-5 text-sm text-muted-foreground">
              {t("Loading conversation history…")}
            </p>
          ) : (
            <ConversationScopeContext.Provider
              value={{
                sessionId,
                threadId: sessionId,
                apiBase,
                workspaceRoot:
                  match.summary?.workingDirectory ?? execution.workingDirectory,
                capabilities: {
                  editable: false,
                  supportsContextExcerpts: false,
                  historyOwnership: "canonical",
                },
                interactiveQuestions: false,
                loadTurnActivity,
              }}
            >
              <ConversationMessages view={projectExecutionView(execution)} />
            </ConversationScopeContext.Provider>
          )
        ) : (
          <p role="alert" className="py-5 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <button
          type="button"
          className="underline disabled:opacity-40"
          disabled={earlier === undefined}
          onClick={() => {
            if (earlier !== undefined) setPosition({ before: earlier })
          }}
        >
          {t("Earlier")}
        </button>
        <button
          type="button"
          className="underline disabled:opacity-40"
          disabled={later === undefined}
          onClick={() => {
            if (later !== undefined) setPosition({ after: later })
          }}
        >
          {t("Later")}
        </button>
        <button
          type="button"
          className="ml-auto underline"
          onClick={() => {
            close()
            void useAppStore.getState().selectSession(sessionId, match.summary)
          }}
        >
          {t("Open conversation")}
        </button>
      </div>
    </SidebarDialog>
  )
}
