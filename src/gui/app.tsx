import { Plus } from "lucide-react"
import { ApprovalBar } from "./components/approval-bar.tsx"
import { Composer } from "./components/composer.tsx"
import { DiagnosticsDrawer } from "./components/diagnostics-drawer.tsx"
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
          <Separator />
          <ThreadList />
          <Separator />
          <ApiConnectForm />
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
              <DiagnosticsDrawer />
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

function ApiConnectForm() {
  const apiBase = useAppStore((state) => state.apiBase)
  const connectApiBase = useAppStore((state) => state.connectApiBase)
  return (
    <form
      className="flex items-center gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        connectApiBase(String(data.get("apiBase") ?? "").trim())
      }}
    >
      <label htmlFor="apiBase" className="text-xs text-muted-foreground">
        API
      </label>
      <input
        id="apiBase"
        name="apiBase"
        defaultValue={apiBase}
        className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <Button type="submit" size="sm" variant="secondary">
        Connect
      </Button>
    </form>
  )
}

function SessionHeader() {
  const session = useAppStore((state) => state.selectedSession)
  const view = useExecutionView()
  if (!session) return null
  return (
    <header className="border-b px-4 py-2">
      <div className="flex items-baseline gap-2">
        <h2 className="truncate text-sm font-semibold">
          {session.title ?? "Untitled session"}
        </h2>
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
