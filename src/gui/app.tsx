import { GitFork, Plus } from "lucide-react"
import { ApprovalBar } from "./components/approval-bar.tsx"
import { Composer } from "./components/composer.tsx"
import { ProjectSwitcher } from "./components/project-switcher.tsx"
import { StatusSurface } from "./components/status-surface.tsx"
import { ThreadList } from "./components/thread-list.tsx"
import { Transcript } from "./components/transcript.tsx"
import { Button } from "./components/ui/button.tsx"
import { Separator } from "./components/ui/separator.tsx"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx"
import { useAppStore, useExecutionView } from "./store/app-store.ts"

export function App() {
  const message = useAppStore((state) => state.message)
  const hasSession = useAppStore((state) => state.selectedSession !== undefined)

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <div className="flex items-center justify-between gap-2 px-3 py-3">
            <div>
              <h1 className="text-sm font-semibold">Yakitori</h1>
              <p className="text-xs text-muted-foreground">Coding workbench</p>
            </div>
            <NewSessionButton />
          </div>
          <ProjectSwitcher />
          <Separator />
          <ThreadList />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {message !== undefined && message !== "" && (
            <div
              role="alert"
              className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
            >
              {message}
            </div>
          )}
          {hasSession ? (
            <>
              <SessionHeader />
              <Transcript />
              <ApprovalBar />
              <StatusSurface />
              <Composer />
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </TooltipProvider>
  )
}

function NewSessionButton() {
  const createSession = useAppStore((state) => state.createSession)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="New session"
          onClick={() => void createSession()}
        >
          <Plus />
        </Button>
      </TooltipTrigger>
      <TooltipContent>New session</TooltipContent>
    </Tooltip>
  )
}

function SessionHeader() {
  const session = useAppStore((state) => state.selectedSession)
  const sessions = useAppStore((state) => state.sessions)
  const selectSession = useAppStore((state) => state.selectSession)
  const view = useExecutionView()
  if (!session) return null
  const parent = sessions.find(
    (candidate) => candidate.id === session.parentSessionId,
  )
  return (
    <header className="border-b px-4 py-2">
      <div className="flex items-center gap-2">
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
        <span className="truncate font-mono text-xs text-muted-foreground">
          {session.id}
        </span>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        mate {view.mateId ?? "—"} · rev {view.mateRevisionId ?? "—"} ·{" "}
        {view.workingDirectory ?? "—"} · {session.counts.turns} turns ·{" "}
        {session.counts.inputs} inputs · {session.counts.tools} tools
      </p>
    </header>
  )
}

function EmptyState() {
  const createSession = useAppStore((state) => state.createSession)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <p className="text-sm text-muted-foreground">No session selected</p>
      <Button type="button" onClick={() => void createSession()}>
        <Plus /> New session
      </Button>
    </div>
  )
}
