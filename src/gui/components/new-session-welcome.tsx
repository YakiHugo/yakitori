import { Check, ChevronDown, Folder, Plus, Search, X } from "lucide-react"
import { useId, useLayoutEffect, useRef, useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import { CreateProjectDialog } from "./sidebar-add-project.tsx"
import "./new-session-welcome.css"

export function NewSessionWelcome() {
  const projects = useAppStore((state) => state.projects)
  const projectId = useAppStore((state) =>
    state.selectedSession === undefined
      ? state.currentProject
      : state.selectedSession.projectId,
  )
  const hasSession = useAppStore(
    (state) => state.selection.sessionId !== undefined,
  )
  const [query, setQuery] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const pickerId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const project = projects.find((entry) => entry.id === projectId)
  const heading = project
    ? `What should we build in ${project.name}?`
    : "What should we build?"
  const search = query.trim().toLowerCase()
  const matches = projects.filter((entry) =>
    entry.name.toLowerCase().includes(search),
  )
  useLayoutEffect(() => {
    if (pickerOpen) searchRef.current?.focus()
  }, [pickerOpen])
  const select = (id?: string) => {
    pickerRef.current?.hidePopover()
    useAppStore.getState().setNewSessionProject(id)
  }

  return (
    <div className="new-session-welcome">
      <h2 className="new-session-heading" aria-label={heading}>
        {project ? "What should we build in " : heading}
        <span className="new-session-scope" data-project={!!project}>
          <button
            type="button"
            className="new-session-project"
            aria-label="New session project"
            aria-describedby={`${pickerId}-selection`}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            disabled={hasSession}
            popoverTarget={pickerId}
            title={project?.name}
          >
            {!project && <Folder size={14} aria-hidden="true" />}
            <span id={`${pickerId}-selection`}>
              {project?.name ?? "No project"}
            </span>
            {!project && <ChevronDown size={12} aria-hidden="true" />}
          </button>
          {project && "?"}
        </span>
      </h2>
      <div
        ref={pickerRef}
        id={pickerId}
        className="new-session-project-picker"
        role="dialog"
        aria-label="Choose a project"
        aria-hidden={!pickerOpen}
        popover="auto"
        onBeforeToggle={(event) => {
          // A quick reopen can coalesce the native close and open toggle events.
          if (event.newState === "closed") setQuery("")
        }}
        onToggle={(event) => {
          setPickerOpen(event.newState === "open")
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.target === searchRef.current && event.key === "Enter") {
            event.preventDefault()
            const [match] = matches
            if (search && matches.length === 1 && match) select(match.id)
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
          const buttons = Array.from(
            event.currentTarget.querySelectorAll("button"),
          )
          const index =
            event.target instanceof HTMLButtonElement
              ? buttons.indexOf(event.target)
              : -1
          const next = index + (event.key === "ArrowDown" ? 1 : -1)
          event.preventDefault()
          if (next === -1) searchRef.current?.focus()
          else buttons[next]?.focus()
        }}
      >
        <label className="new-session-project-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="new-session-project-results">
          {matches.length === 0 && (
            <p role="status">
              {search ? "No matching projects" : "No projects yet"}
            </p>
          )}
          {matches.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.name}
              aria-pressed={entry.id === projectId}
              onClick={() => select(entry.id)}
            >
              <Folder size={16} aria-hidden="true" />
              <span>{entry.name}</span>
              {entry.id === projectId && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="new-session-project-actions">
          <button
            type="button"
            onClick={() => {
              pickerRef.current?.hidePopover()
              setCreatingProject(true)
            }}
          >
            <Plus size={16} aria-hidden="true" />
            <span>Create project</span>
          </button>
          <button
            type="button"
            aria-pressed={projectId === undefined}
            onClick={() => select()}
          >
            <X size={16} aria-hidden="true" />
            <span>Work without a project</span>
            {projectId === undefined && <Check size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <CreateProjectDialog
        open={creatingProject}
        onClose={() => setCreatingProject(false)}
      />
    </div>
  )
}
