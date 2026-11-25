import { useTranslation } from "./i18n/use-translation.ts"
import { GitFork, LoaderCircle, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ApprovalBar } from "./components/approval-bar.tsx"
import { Composer } from "./components/composer.tsx"
import {
  EngineConversation,
  EngineSessionHeading,
} from "./components/engine-session.tsx"
import { HistoryMatchDialog } from "./components/history-match-dialog.tsx"
import { NewSessionWelcome } from "./components/new-session-welcome.tsx"
import { PreferencesEffects } from "./components/preferences-effects.tsx"
import { QueuedInputs } from "./components/queued-inputs.tsx"
import { GoalBar, GoalEditor } from "./components/session-goal.tsx"
import { SessionSummary } from "./components/session-summary.tsx"
import { SettingsPage } from "./components/settings-page.tsx"
import { SidebarNameDialog } from "./components/sidebar-name-dialog.tsx"
import { Transcript } from "./components/transcript.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { WorkspaceFrame } from "./components/workspace-frame.tsx"
import { useChatInterrupt } from "./hooks/use-chat-interrupt.ts"
import {
  type ComposerRoute,
  useComposerRoute,
} from "./hooks/use-composer-route.ts"
import { useSessionRead } from "./hooks/use-session-read.ts"
import { UNCONFIRMED_INPUT_NOTICE } from "./input-recovery-memory.ts"
import { useAppStore, useExecutionView } from "./store/app-store.ts"
import { useEngineStore } from "./store/engine-store.ts"

export function App() {
  const { t } = useTranslation()
  useSessionRead()
  const externalSession = useEngineStore((state) => state.engineId)
  const externalSessionId = useEngineStore((state) => state.sessionId)
  const message = useAppStore((state) => state.message || state.providersError)
  const hydrating = useAppStore(
    (state) =>
      state.hydratingSessionId !== undefined &&
      state.hydratingSessionId === state.selection.sessionId,
  )
  const hasSession = useAppStore((state) => state.selectedSession !== undefined)
  const archived = useAppStore((state) => state.selectedSession?.archived)
  const route = useComposerRoute(externalSession === undefined && !archived)
  const emptySession = useAppStore((state) => {
    if (
      state.execution.entries.length > 0 ||
      state.execution.activeTurnId !== undefined
    )
      return false
    if (state.selection.sessionId === undefined) return true
    const session = state.selectedSession
    // A snapshot can precede its history. Only a known empty session keeps
    // the welcome layout while creation and initial replay finish.
    return (
      session?.id === state.selection.sessionId &&
      !session.archived &&
      !session.active &&
      session.activeTurnId === undefined &&
      session.counts.inputs === 0 &&
      session.counts.turns === 0 &&
      session.counts.items === 0
    )
  })
  const settingsOpen = useAppStore(
    (state) => state.settingsSection !== undefined,
  )
  const showSessionHeader =
    !settingsOpen &&
    externalSession === undefined &&
    hasSession &&
    !emptySession

  const interruptSessionId = useAppStore((state) => state.selection.sessionId)
  const interruptTurnId = useExecutionView().activeTurnId
  const stopping = useAppStore(
    (state) =>
      interruptTurnId !== undefined &&
      state.inFlightActions.has(`cancel:${interruptTurnId}`),
  )
  const interrupt = useChatInterrupt({
    sessionId: interruptSessionId,
    turnId:
      settingsOpen || hydrating || externalSession !== undefined
        ? undefined
        : interruptTurnId,
    stopping,
    onInterrupt: () => {
      const state = useAppStore.getState()
      if (
        state.selection.sessionId === interruptSessionId &&
        state.execution.activeTurnId === interruptTurnId &&
        interruptTurnId !== undefined &&
        state.settingsSection === undefined &&
        useEngineStore.getState().engineId === undefined
      )
        void state.cancelTurn(interruptTurnId)
    },
  })

  return (
    <TooltipProvider>
      <PreferencesEffects />
      <HistoryMatchDialog />
      <WorkspaceFrame
        usageAccountId={route.preview?.target?.provider}
        heading={
          settingsOpen ? (
            <span>{t("Settings")}</span>
          ) : externalSession !== undefined ? (
            <EngineSessionHeading />
          ) : showSessionHeader ? (
            <SessionHeader />
          ) : (
            <span>
              {hydrating ? t("Loading conversation…") : t("New session")}
            </span>
          )
        }
        sessionActions={showSessionHeader ? <SessionSummary /> : undefined}
      >
        <main
          {...interrupt}
          className="flex min-w-0 flex-1 flex-col bg-background"
        >
          {message !== undefined && message !== "" && (
            <div
              role="alert"
              className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
            >
              <span>{message}</span>
              {message === UNCONFIRMED_INPUT_NOTICE && (
                <button
                  type="button"
                  className="ml-3 underline"
                  title={t(
                    "Hide this reminder only. The input may still be delivered; nothing is cancelled or resent.",
                  )}
                  onClick={() =>
                    useAppStore.getState().dismissInputRecoveryNotice()
                  }
                >
                  {t("Dismiss reminder")}
                </button>
              )}
            </div>
          )}
          {settingsOpen ? (
            <SettingsPage />
          ) : externalSession !== undefined ? (
            <EngineConversation key={externalSessionId ?? externalSession} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript
                  loading={hydrating}
                  emptyState={emptySession ? <NewSessionWelcome /> : undefined}
                >
                  {hydrating ? null : <ApprovalBar />}
                  {hydrating ? null : <QueuedInputs />}
                  {hydrating ? null : <GoalBar />}
                  <SessionComposer route={route} />
                </Transcript>
              </div>
              {hasSession && !hydrating ? <GoalEditor /> : null}
            </div>
          )}
        </main>
      </WorkspaceFrame>
    </TooltipProvider>
  )
}

function SessionComposer({ route }: Readonly<{ route: ComposerRoute }>) {
  const { t } = useTranslation()
  const session = useAppStore((state) => state.selectedSession)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const cancelTurn = useAppStore((state) => state.cancelTurn)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const activeTurnId = useExecutionView().activeTurnId
  const pending = useAppStore((state) =>
    state.inFlightActions.has("sidebar-update"),
  )
  const hydrating = useAppStore(
    (state) =>
      state.hydratingSessionId !== undefined &&
      state.hydratingSessionId === state.selection.sessionId,
  )
  if (!session?.archived) return <Composer route={route} />
  if (hydrating) return null
  const stopping =
    activeTurnId !== undefined && inFlightActions.has(`cancel:${activeTurnId}`)
  return (
    <div className="mx-auto mb-5 flex max-w-3xl items-center justify-between gap-4 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
      <span>{t("This conversation is archived.")}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {activeTurnId !== undefined && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5"
            disabled={stopping}
            title={t("Interrupt (Esc)")}
            onClick={() => void cancelTurn(activeTurnId)}
          >
            {stopping ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Square className="size-4" />
            )}
            {stopping ? t("Stopping…") : t("Interrupt")}
          </button>
        )}
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
          disabled={pending}
          onClick={() =>
            void changeSidebar({
              type: "session",
              sessionId: session.id,
              archived: false,
            })
          }
        >
          {t("Restore conversation")}
        </button>
      </div>
    </div>
  )
}

function SessionHeader() {
  const { t } = useTranslation()
  const session = useAppStore((state) => state.selectedSession)
  const sessionsByProject = useAppStore((state) => state.sessionsByProject)
  const selectSession = useAppStore((state) => state.selectSession)
  if (!session) return null
  const parent = Object.values(sessionsByProject)
    .flatMap((list) => list.sessions)
    .find((candidate) => candidate.id === session.parentSessionId)
  return (
    <div className="window-session-heading">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-sm font-semibold">
          {session.title ?? t("Untitled session")}
        </h2>
        {session.parentSessionId !== undefined ? (
          <button
            type="button"
            onClick={() =>
              void selectSession(session.parentSessionId as string)
            }
            className="inline-flex max-w-64 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("Open parent session")}
          >
            <GitFork className="size-3" />
            <span className="truncate">
              {t("fork from")} {parent?.title ?? "parent"}
            </span>
          </button>
        ) : null}
      </div>
      <SessionRename />
    </div>
  )
}

function SessionRename() {
  const { t } = useTranslation()
  const session = useAppStore((state) => state.selectedSession)
  const revision = useAppStore((state) => state.renameDialogRevision)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const [open, setOpen] = useState(false)
  const previousRevision = useRef(revision)
  useEffect(() => {
    if (previousRevision.current === revision) return
    previousRevision.current = revision
    setOpen(true)
  }, [revision])
  return open && session ? (
    <SidebarNameDialog
      title={t("Rename conversation")}
      initialName={session.title ?? ""}
      onClose={() => setOpen(false)}
      onSave={(title) =>
        changeSidebar({ type: "session", sessionId: session.id, title })
      }
    />
  ) : null
}
