import { Folder, FolderPlus, Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAppStore } from "../store/app-store.ts"
import { SidebarDialog } from "./sidebar-surfaces.tsx"

export function AddProjectButton() {
  const addProject = useAppStore((state) => state.addProject)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const active = useRef(false)
  const focusAfterDialog = useRef(false)
  useEffect(() => {
    if (open || !focusAfterDialog.current) return
    focusAfterDialog.current = false
    // The modal must release focus before the new project's composer can take it.
    useAppStore.setState((state) => ({
      composerFocusRevision: state.composerFocusRevision + 1,
    }))
  }, [open])
  const choose = async () => {
    if (active.current || !window.yakitoriDesktop) return
    active.current = true
    setPending(true)
    setError(undefined)
    try {
      const folder = await window.yakitoriDesktop.pickProjectFolder()
      if (folder !== null) {
        setPath(folder)
        setName(
          (current) =>
            current || folder.split("/").filter(Boolean).at(-1) || folder,
        )
      }
    } catch (error) {
      // Report native dialog/IPC failures at the UI boundary and permit retry.
      setError(
        error instanceof Error
          ? error.message
          : "Could not open the folder picker.",
      )
    } finally {
      active.current = false
      setPending(false)
    }
  }
  return (
    <>
      <button
        type="button"
        aria-label="Add project"
        title="Add project"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          setName("")
          setPath("")
          setError(undefined)
          setOpen(true)
        }}
        className="sidebar-icon size-6 disabled:opacity-40"
      >
        <Plus size={15} />
      </button>
      {open && (
        <SidebarDialog
          title="Create project"
          className="create-project-dialog"
          dismissible={!pending}
          onClose={() => setOpen(false)}
        >
          <form
            className="create-project-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (active.current || !path.trim() || !name.trim()) return
              active.current = true
              setPending(true)
              setError(undefined)
              void addProject(path, name)
                .then((done) => {
                  if (done) {
                    focusAfterDialog.current = true
                    setOpen(false)
                  } else {
                    setError(
                      useAppStore.getState().message ??
                        "Could not create the project. Try again.",
                    )
                  }
                })
                .finally(() => {
                  active.current = false
                  setPending(false)
                })
            }}
          >
            <div className="create-project-name">
              <span aria-hidden="true">
                <Folder size={18} />
              </span>
              <input
                data-autofocus
                aria-label="Project name"
                placeholder="Project name"
                autoComplete="off"
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="create-project-source">
              <h3>Source folder</h3>
              {window.yakitoriDesktop ? (
                path ? (
                  <div className="create-project-folder">
                    <Folder size={20} aria-hidden="true" />
                    <button
                      type="button"
                      className="create-project-folder-path"
                      title={path}
                      aria-label="Change source folder"
                      disabled={pending}
                      onClick={() => void choose()}
                    >
                      <strong>
                        {path.split("/").filter(Boolean).at(-1) || path}
                      </strong>
                      <span>{path}</span>
                    </button>
                    <button
                      type="button"
                      className="sidebar-icon"
                      aria-label="Remove source folder"
                      disabled={pending}
                      onClick={() => {
                        setPath("")
                        setError(undefined)
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="create-project-choose"
                    disabled={pending}
                    onClick={() => void choose()}
                  >
                    <FolderPlus size={22} aria-hidden="true" />
                    <span>Add a folder Yakitori can read and edit</span>
                  </button>
                )
              ) : (
                <div className="create-project-path">
                  <FolderPlus size={22} aria-hidden="true" />
                  <input
                    aria-label="Project path"
                    placeholder="/Users/you/Projects/my-project"
                    autoComplete="off"
                    spellCheck={false}
                    value={path}
                    disabled={pending}
                    aria-invalid={!!error}
                    aria-describedby={
                      error ? "project-folder-error" : undefined
                    }
                    onChange={(event) => {
                      setPath(event.target.value)
                      setError(undefined)
                    }}
                  />
                </div>
              )}
            </div>
            {error && (
              <p
                id="project-folder-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <div className="create-project-actions">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || !path.trim() || !name.trim()}
              >
                {pending ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </SidebarDialog>
      )}
    </>
  )
}
