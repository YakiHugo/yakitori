import { translate, useTranslation } from "../i18n/use-translation.ts"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { AppSessionEventEnvelope } from "../../protocol/events.ts"
import { prependSessionTurns } from "../lib/session-turn-history.ts"
import {
  createExecutionViewState,
  appendTurnActivityPage,
  type ExecutionViewState,
  prependExecutionHistory,
  projectExecutionView,
} from "../execution-view.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { type HistoryMatch, useAppStore } from "../store/app-store.ts"
import { ConversationMessages } from "./conversation-messages.tsx"
import { ConversationScopeContext } from "./conversation-scope.tsx"
import { SidebarDialog } from "./sidebar-surfaces.tsx"

type HistoryPage = Readonly<{
  execution: ExecutionViewState
  before?: number
  after?: number
  focusItemId?: string
}>
type HistoryPosition = Readonly<{
  direction: "before" | "after"
  cursor: number
}>

function matchesHistoryItem(
  event: AppSessionEventEnvelope,
  itemId: string,
): boolean {
  return event.type === "input.admitted"
    ? event.data.inputId === itemId
    : event.type === "item.completed" && event.data.item.itemId === itemId
}

async function readHistoryMatchPage(
  apiBase: string,
  { sessionId, location }: HistoryMatch,
  position: HistoryPosition | undefined,
): Promise<HistoryPage> {
  const client = getAppRpcClient(apiBase)
  const page = await client.request("session/turns/list", {
    sessionId,
    rolloutId: location.rolloutId,
    view: "summary",
    ...(position === undefined
      ? { aroundTurnId: location.turnId }
      : { [position.direction]: position.cursor }),
  })
  if (page.view !== "summary") throw new Error("Expected a Turn summary page.")
  let execution = prependSessionTurns(createExecutionViewState(), page.turns)
  if (page.activeTurn !== undefined) {
    execution = prependExecutionHistory(execution, page.activeTurn.events)
    if (page.activeTurn.activityBefore !== undefined)
      execution = {
        ...execution,
        deferredTurnActivity: {
          ...execution.deferredTurnActivity,
          [page.activeTurn.turnId]: page.activeTurn.activityBefore,
        },
      }
  }
  let focusItemId =
    position === undefined && location.resultItemId !== undefined
      ? location.itemId
      : undefined
  if (position === undefined) {
    const anchorTurn =
      page.activeTurn ??
      page.turns.find((turn) => turn.turnId === location.turnId)
    if (
      !anchorTurn?.events.some((event) =>
        matchesHistoryItem(event, location.itemId),
      )
    ) {
      const result = await client.request("session/turn/activity", {
        sessionId,
        rolloutId: location.rolloutId,
        turnId: location.turnId,
        aroundItemId: location.itemId,
      })
      const { deferredTurnActivity } = execution
      execution = {
        ...appendTurnActivityPage(
          execution,
          location.turnId,
          result.events,
          undefined,
        ),
        deferredTurnActivity,
      }
      focusItemId = location.itemId
    }
  }
  return {
    execution,
    ...(page.nextBefore === undefined ? {} : { before: page.nextBefore }),
    ...(page.nextAfter === undefined ? {} : { after: page.nextAfter }),
    ...(focusItemId === undefined ? {} : { focusItemId }),
  }
}

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
  const [position, setPosition] = useState<HistoryPosition>()
  const [page, setPage] = useState<HistoryPage>()
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
    void readHistoryMatchPage(apiBase, match, position).then(
      (response) => {
        if (requestVersion.current !== revision) return
        setPage(response)
        setExecution(response.execution)
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
  }, [apiBase, match, position])

  useLayoutEffect(() => {
    if (page === undefined) return
    const content = viewport.current
    if (content === null) return
    const anchor =
      position === undefined
        ? content.querySelector(
            `[data-context-message-id="${CSS.escape(location.itemId)}"]`,
          )
        : undefined
    if (!(anchor instanceof HTMLElement)) {
      content.scrollTop =
        position?.direction === "after" ? content.scrollHeight : 0
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
        "session/turn/activity",
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
          : appendTurnActivityPage(
              current,
              turnId,
              response.events,
              response.nextBefore,
            ),
      )
    },
    [apiBase, execution?.deferredTurnActivity, location.rolloutId, sessionId],
  )

  const earlier = page?.before
  const later = page?.after
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
                threadId: `history-match:${sessionId}:${location.itemId}`,
                focusItemId: page?.focusItemId,
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
            if (earlier !== undefined && page !== undefined)
              setPosition({
                direction: "before",
                cursor: earlier,
              })
          }}
        >
          {t("Earlier")}
        </button>
        <button
          type="button"
          className="underline disabled:opacity-40"
          disabled={later === undefined}
          onClick={() => {
            if (later !== undefined && page !== undefined)
              setPosition({
                direction: "after",
                cursor: later,
              })
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
