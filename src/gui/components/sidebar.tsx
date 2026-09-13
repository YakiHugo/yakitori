import { Folder, FolderOpen, GitFork, Plus, SquarePen, Trash2 } from "lucide-react"
import { useState } from "react"
import type { ApiProject } from "../../server/protocol.ts"
import { formatTime } from "../lib/format.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

// Codex GUI-style sidebar: one scrolling column with a primary New session row
// and a flat project tree. Selecting a project expands its sessions inline —
// the store only ever tracks the current project's sessions, so expansion and
// selection are the same action.
export function Sidebar() {
  const projects = useAppStore((state) => state.projects)
  const currentProject = useAppStore((state) => state.currentProject)
  const createSession = useAppStore((state) => state.createSession)
  // Servers without the project store never populate project state.
  const hasProjects = projects.length > 0 || currentProject !== undefined

  return (
    <>
      <div className="px-3 py-3">
        <h1 className="text-sm font-semibold">Yakitori</h1>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          <button
            type="button"
            aria-label="New session"
            onClick={() => void createSession()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <SquarePen className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">New session</span>
            <Plus className="size-4 shrink-0 text-muted-foreground" />
          </button>
          {hasProjects ? <ProjectsSection /> : <SessionItems />}
        </div>
      </ScrollArea>
    </>
  )
}

function ProjectsSection() {
  const projects = useAppStore((state) => state.projects)
  const currentProject = useAppStore((state) => state.currentProject)
  const busy = useAppStore((state) => state.busy)
  const selectProject = useAppStore((state) => state.selectProject)
  const addProject = useAppStore((state) => state.addProject)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")

  return (
    <div className="mt-2 flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <button
          type="button"
          aria-label="Add project"
          onClick={() => setAdding((value) => !value)}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {projects.map((project) => (
        <div key={project.id} className="flex flex-col gap-0.5">
          <button
            type="button"
            title={project.roots[0] ?? project.name}
            aria-current={project.id === currentProject}
            onClick={() => void selectProject(project.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
              project.id === currentProject && "bg-accent",
            )}
          >
            {project.id === currentProject ? (
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {projectLabel(project)}
            </span>
          </button>
          {project.id === currentProject && (
            <div className="ml-4 flex flex-col gap-0.5 border-l pl-2">
              <SessionItems />
            </div>
          )}
        </div>
      ))}
      {adding && (
        <form
          className="flex items-center gap-2 px-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault()
            const path = draft.trim()
            if (path === "") return
            setDraft("")
            setAdding(false)
            void addProject(path)
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add project (absolute path)"
            aria-label="Project path"
            className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={busy || draft.trim() === ""}
          >
            Add
          </Button>
        </form>
      )}
    </div>
  )
}

function SessionItems() {
  const sessions = useAppStore((state) => state.sessions)
  const selectedId = useAppStore((state) => state.selection.sessionId)
  const nextCursor = useAppStore((state) => state.nextCursor)
  const selectSession = useAppStore((state) => state.selectSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>()

  if (sessions.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground">No sessions</p>
    )
  }
  return (
    <>
      {sessions.map((session) =>
        pendingDeleteId === session.id ? (
          <div
            key={session.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5"
          >
            <span className="flex-1 text-xs text-muted-foreground">
              Delete conversation? This cannot be undone.
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setPendingDeleteId(undefined)
                void deleteSession(session.id)
              }}
            >
              Confirm
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPendingDeleteId(undefined)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div key={session.id} className="group flex items-center">
            <button
              type="button"
              aria-current={session.id === selectedId}
              onClick={() => void selectSession(session.id)}
              className={cn(
                "min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                session.id === selectedId && "bg-accent",
              )}
            >
              <span className="flex items-center gap-1.5 truncate text-sm">
                {session.parentSessionId !== undefined &&
                session.forkReason === undefined ? (
                  <GitFork className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <span className="truncate">
                  {session.title ?? "Untitled session"}
                </span>
              </span>
              <span className="block text-xs text-muted-foreground">
                seq {session.seq} · {formatTime(session.updatedAt)}
              </span>
            </button>
            <button
              type="button"
              aria-label="Delete conversation"
              onClick={() => setPendingDeleteId(session.id)}
              className="rounded-md p-1.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ),
      )}
      {nextCursor !== undefined && (
        <button
          type="button"
          onClick={() => void loadSessions({ append: true })}
          className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Show more
        </button>
      )}
    </>
  )
}

// Projects are named on creation (default: the first root's basename); an
// empty name falls back to the root path.
function projectLabel(project: ApiProject): string {
  if (project.name.trim() !== "") return project.name
  const root = project.roots[0]
  if (root === undefined) return project.id
  return basename(root)
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}
