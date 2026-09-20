import { GitFork, Info, LoaderCircle, Search, Square } from "lucide-react"
import { ApprovalBar } from "./components/approval-bar.tsx"
import { Composer } from "./components/composer.tsx"
import { openConversationFind } from "./components/conversation-find.tsx"
import { QueuedInputs } from "./components/queued-inputs.tsx"
import { PreferencesEffects } from "./components/preferences-effects.tsx"
import { SessionSummary } from "./components/session-summary.tsx"
import { TelemetryRail } from "./components/telemetry-rail.tsx"
import { Transcript } from "./components/transcript.tsx"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx"
import { WorkspaceFrame } from "./components/workspace-frame.tsx"
import { useAppStore, useExecutionView } from "./store/app-store.ts"

export function App() {
  const message = useAppStore((state) => state.message)
  const hydrating = useAppStore(
    (state) =>
      state.hydratingSessionId !== undefined &&
      state.hydratingSessionId === state.selection.sessionId,
  )
  const hasSession = useAppStore((state) => state.selectedSession !== undefined)

  return (
    <TooltipProvider>
      <PreferencesEffects />
      <WorkspaceFrame>
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {message !== undefined && message !== "" && (
            <div
              role="alert"
              className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
            >
              {message}
            </div>
          )}
          {hydrating ? (
            <div
              role="status"
              className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
            >
              Loading conversation…
            </div>
          ) : hasSession ? (
            <>
              <SessionHeader />
              <TelemetryRail />
              <Transcript>
                <ApprovalBar />
                <QueuedInputs />
                <SessionComposer />
              </Transcript>
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </WorkspaceFrame>
    </TooltipProvider>
  )
}

function SessionComposer() {
  const session = useAppStore((state) => state.selectedSession)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const cancelTurn = useAppStore((state) => state.cancelTurn)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const activeTurnId = useExecutionView().activeTurnId
  const pending = useAppStore((state) =>
    state.inFlightActions.has("sidebar-update"),
  )
  if (!session?.archived) return <Composer />
  const stopping =
    activeTurnId !== undefined && inFlightActions.has(`cancel:${activeTurnId}`)
  return (
    <div className="mx-auto mb-5 flex max-w-3xl items-center justify-between gap-4 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
      <span>This conversation is archived.</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {activeTurnId !== undefined && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5"
            disabled={stopping}
            onClick={() => void cancelTurn(activeTurnId)}
          >
            {stopping ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Square className="size-4" />
            )}
            {stopping ? "Stopping…" : "Interrupt"}
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
          Restore conversation
        </button>
      </div>
    </div>
  )
}

function SessionHeader() {
  const session = useAppStore((state) => state.selectedSession)
  const sessionsByProject = useAppStore((state) => state.sessionsByProject)
  const selectSession = useAppStore((state) => state.selectSession)
  const view = useExecutionView()
  if (!session) return null
  const parent = Object.values(sessionsByProject)
    .flatMap((list) => list.sessions)
    .find((candidate) => candidate.id === session.parentSessionId)
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-5">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-sm font-semibold">
          {session.title ?? "Untitled session"}
        </h2>
        {session.parentSessionId !== undefined &&
        session.forkReason === undefined ? (
          <button
            type="button"
            onClick={() =>
              void selectSession(session.parentSessionId as string)
            }
            className="inline-flex max-w-64 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open parent session"
          >
            <GitFork className="size-3" />
            <span className="truncate">
              fork from {parent?.title ?? "parent"}
            </span>
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Find in conversation"
          title="Find in conversation (⌘F / Ctrl+F)"
          onClick={openConversationFind}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
        >
          <Search className="size-4" />
        </button>
        <SessionSummary />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Session details"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            >
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <p>{view.workingDirectory}</p>
            <p>
              {session.counts.turns} turns · {session.counts.inputs} inputs ·{" "}
              {session.counts.tools} tools
            </p>
            <p className="font-mono text-[10px]">{session.id}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

function EmptyState() {
  const projects = useAppStore((state) => state.projects)
  const currentProject = useAppStore((state) => state.currentProject)
  const project = projects.find((candidate) => candidate.id === currentProject)
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center">
      <div className="mx-auto w-full max-w-3xl">
        <h2 className="mb-3 text-center text-xl font-medium">
          {project
            ? `What would you like to build in ${project.name}?`
            : "What would you like to work on?"}
        </h2>
        <div className="mb-7 flex justify-center">
          <select
            aria-label="New session project"
            value={currentProject ?? ""}
            className="max-w-full rounded-md border bg-background px-3 py-1.5 text-xs"
            onChange={(event) =>
              useAppStore.setState({
                currentProject: event.target.value || undefined,
              })
            }
          >
            <option value="">No project</option>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <Composer />
      </div>
    </div>
  )
}
