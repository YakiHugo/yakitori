import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Pin,
  Search,
  SquarePen,
  X,
} from "lucide-react"
import { useContext, useEffect, useState } from "react"
import type { ApiProject } from "../../server/protocol.ts"
import { cn } from "../lib/utils.ts"
import { sessionListKey, useAppStore } from "../store/app-store.ts"
import { AddProjectButton } from "./sidebar-add-project.tsx"
import { SidebarDragKind } from "./sidebar-drag.tsx"
import { SidebarGroups, SidebarOptions } from "./sidebar-groups.tsx"
import { useSidebarMotion } from "./sidebar-motion.ts"
import { SessionItems } from "./sidebar-sessions.tsx"
import { SidebarDialog, SidebarMenu } from "./sidebar-surfaces.tsx"
import { SubscriptionPanelButton } from "./subscription-panel.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent } from "./ui/collapsible.tsx"

export function Sidebar({ onSearch }: Readonly<{ onSearch(): void }>) {
  const navRef = useSidebarMotion()
  const dragging = useContext(SidebarDragKind)
  const emptyPinned = useAppStore((state) => {
    const list =
      state.sessionsByProject[
        sessionListKey(undefined, { sectionId: "pinned" })
      ]
    return (
      list !== undefined &&
      !list.error &&
      list.sessions.length === 0 &&
      !state.projects.some((project) => project.pinned)
    )
  })
  const showPinTarget =
    emptyPinned && (dragging === "session" || dragging === "project")
  const projects = useAppStore((state) => state.projects)
  const startNewSession = useAppStore((state) => state.startNewSession)
  const [showAll, setShowAll] = useState(false)
  const loadSessions = useAppStore((state) => state.loadSessions)
  return (
    <>
      <div className="sidebar-heading group">
        <h1 className="sr-only">Yakitori</h1>
        <SidebarOptions />
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Search sessions"
            title="Search sessions"
            className="sidebar-icon"
            onClick={onSearch}
          >
            <Search size={16} />
          </button>
        </div>
      </div>
      <div className="relative px-2 pb-3">
        <button
          type="button"
          aria-label="New session"
          className={cn("sidebar-row w-full", showPinTarget && "invisible")}
          onClick={() => startNewSession()}
        >
          <SquarePen size={16} />
          <span className="flex-1 text-left">New session</span>
          <span className="text-xs text-muted-foreground">⌘ N</span>
        </button>
        {showPinTarget && (
          <div
            className="sidebar-row absolute inset-x-2 top-0"
            data-sidebar-drop="section"
            data-drop-id="pinned"
            data-drop-label="Pinned"
          >
            <Pin size={16} />
            <span>Drop here to pin</span>
          </div>
        )}
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto">
        <nav ref={navRef} aria-label="Sessions" className="px-2 pb-4">
          <SidebarGroups
            pinnedProjects={projects
              .filter((project) => project.pinned)
              .map((project) => (
                <ProjectItem key={project.id} project={project} />
              ))}
          />
          <ProjectsSection />
          {projects.length === 0 ? (
            <SessionItems projectId={undefined} />
          ) : (
            <div className="mt-4">
              <button
                type="button"
                className="sidebar-row w-full text-muted-foreground"
                data-sidebar-drop="default"
                data-drop-label="All sessions"
                aria-expanded={showAll}
                onClick={() => {
                  setShowAll(!showAll)
                  if (!showAll) void loadSessions(undefined)
                }}
              >
                <ChevronRight
                  size={14}
                  className={cn("sidebar-chevron", showAll && "rotate-90")}
                />
                All sessions
              </button>
              {showAll && <SessionItems projectId={undefined} />}
            </div>
          )}
        </nav>
      </div>
      <SubscriptionPanelButton />
    </>
  )
}

function ProjectsSection() {
  const projects = useAppStore((state) => state.projects)
  const projectsError = useAppStore((state) => state.projectsError)
  const loadProjects = useAppStore((state) => state.loadProjects)

  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex items-center justify-between px-2 py-1"
        data-sidebar-drop="default"
        data-drop-label="Projects"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <AddProjectButton />
      </div>
      {projectsError !== undefined && (
        <div className="sidebar-list-note">
          <p>{projectsError}</p>
          <button type="button" onClick={() => void loadProjects()}>
            Retry
          </button>
        </div>
      )}
      {projects
        .filter((project) => !project.pinned)
        .map((project) => (
          <ProjectItem key={project.id} project={project} />
        ))}
    </div>
  )
}

function ProjectItem({ project }: { readonly project: ApiProject }) {
  const collapsed = useAppStore(
    (state) => state.collapsedProjects[project.id] === true,
  )
  const listLoaded = useAppStore(
    (state) =>
      state.sessionsByProject[sessionListKey(project.id)] !== undefined,
  )
  const projects = useAppStore((state) => state.projects)
  const moveProject = useAppStore((state) => state.moveProject)
  const siblings = projects.filter((entry) => entry.pinned === project.pinned)
  const index = siblings.findIndex((entry) => entry.id === project.id)
  const toggleProject = useAppStore((state) => state.toggleProject)
  const toggleProjectPinned = useAppStore((state) => state.toggleProjectPinned)
  const startNewSession = useAppStore((state) => state.startNewSession)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!collapsed && !listLoaded) void loadSessions(project.id)
  }, [collapsed, listLoaded, loadSessions, project.id])

  return (
    <Collapsible
      open={!collapsed}
      className="mb-2"
      data-sidebar-layout={`project:${project.id}`}
    >
      <div
        className="sidebar-project group"
        data-sidebar-drop="project"
        data-drop-id={project.id}
        data-drop-label={projectLabel(project)}
      >
        <SidebarMenu
          label={`Project actions for ${projectLabel(project)}`}
          items={[
            ...(index > 0
              ? [
                  {
                    label: "Move project up",
                    icon: <ArrowUp size={15} />,
                    action: () =>
                      void moveProject(
                        project.id,
                        siblings[index - 1]?.id as string,
                        false,
                      ),
                  },
                ]
              : []),
            ...(index < siblings.length - 1
              ? [
                  {
                    label: "Move project down",
                    icon: <ArrowDown size={15} />,
                    action: () =>
                      void moveProject(
                        project.id,
                        siblings[index + 1]?.id as string,
                        true,
                      ),
                  },
                ]
              : []),
            {
              label: project.pinned ? "Unpin" : "Pin",
              icon: <Pin size={15} />,
              action: () => void toggleProjectPinned(project.id),
            },
            {
              label: "Edit project",
              icon: <Pencil size={15} />,
              action: () => setEditing(true),
            },
            {
              label: "New session",
              icon: <SquarePen size={15} />,
              action: () => startNewSession(project.id),
            },
          ]}
        >
          <button
            type="button"
            data-sidebar-drag="project"
            data-drag-id={project.id}
            data-drag-label={projectLabel(project)}
            title={project.roots[0] ?? project.name}
            aria-expanded={!collapsed}
            onClick={() => void toggleProject(project.id)}
            className="sidebar-row min-w-0 flex-1"
          >
            <span className="sidebar-folder">
              {collapsed ? <Folder size={16} /> : <FolderOpen size={16} />}
              <ChevronRight
                size={14}
                className={cn("sidebar-chevron", !collapsed && "rotate-90")}
              />
            </span>
            <span className="min-w-0 flex-1 truncate text-left">
              {projectLabel(project)}
            </span>
            {project.pinned && <Pin size={12} />}
          </button>
          <button
            type="button"
            aria-label={`New session in ${projectLabel(project)}`}
            className="sidebar-icon sidebar-row-action"
            onClick={() => startNewSession(project.id)}
          >
            <SquarePen size={15} />
          </button>
        </SidebarMenu>
      </div>
      <CollapsibleContent className="sidebar-project-content">
        <SessionItems projectId={project.id} />
      </CollapsibleContent>
      {editing && (
        <EditProjectDialog
          project={project}
          onClose={() => setEditing(false)}
        />
      )}
    </Collapsible>
  )
}

function EditProjectDialog({
  project,
  onClose,
}: {
  readonly project: ApiProject
  readonly onClose: () => void
}) {
  const busy = useAppStore((state) => state.busy)
  const updateProject = useAppStore((state) => state.updateProject)
  const removeProject = useAppStore((state) => state.removeProject)
  const [name, setName] = useState(project.name)
  const [roots, setRoots] = useState<string[]>([...project.roots])
  const [rootDraft, setRootDraft] = useState("")
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const trimmedName = name.trim()
  const rootsChanged =
    roots.length !== project.roots.length ||
    roots.some((root, index) => project.roots[index] !== root)
  const changed = trimmedName !== project.name || rootsChanged
  const canSave = trimmedName !== "" && roots.length > 0 && changed && !busy

  const save = async () => {
    const completed = await updateProject(project.id, {
      ...(trimmedName === project.name ? {} : { name: trimmedName }),
      ...(rootsChanged ? { roots } : {}),
    })
    if (completed) onClose()
  }

  return (
    <SidebarDialog
      title={`Edit project ${projectLabel(project)}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          data-autofocus
          className="h-9 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Source folders
          </span>
          <div className="flex flex-col rounded-md border">
            {roots.map((root, index) => (
              <div
                key={root}
                className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm" title={root}>
                  {root}
                </span>
                <button
                  type="button"
                  aria-label={`Remove folder ${root}`}
                  disabled={roots.length <= 1}
                  onClick={() =>
                    setRoots((current) => current.filter((_, i) => i !== index))
                  }
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <form
              className="flex items-center gap-2 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault()
                const path = rootDraft.trim()
                if (path === "" || roots.includes(path)) return
                setRoots((current) => [...current, path])
                setRootDraft("")
              }}
            >
              <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={rootDraft}
                onChange={(event) => setRootDraft(event.target.value)}
                placeholder="Add folder (absolute path)"
                aria-label="Add folder"
                className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </form>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          {confirmingRemove ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Remove this project? Sessions are kept.
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void removeProject(project.id).then((completed) => {
                    if (completed) onClose()
                  })
                }}
              >
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRemove(false)}
              >
                Keep
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingRemove(true)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Remove project
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </SidebarDialog>
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
