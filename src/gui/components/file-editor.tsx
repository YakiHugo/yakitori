import { FileCode2, Save, WrapText } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import type { WorkspaceReadForEditResponse } from "../../server/workspace.ts"
import { ApiRequestError, getAppRpcClient } from "../lib/rpc-client.ts"
import { CopyIconButton } from "./response-actions.tsx"
import "./workspace-files.css"

const CodeEditor = lazy(() =>
  import("./code-editor.tsx").then((module) => ({
    default: module.CodeEditor,
  })),
)

export function FileEditor({
  cwd,
  path,
  apiBase,
  onClose,
  onDirtyChange,
}: Readonly<{
  cwd: string
  path: string
  apiBase: string
  onClose(): void
  onDirtyChange?(dirty: boolean): void
}>) {
  const [loaded, setLoaded] = useState<WorkspaceReadForEditResponse>()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [saved, setSaved] = useState(false)
  const active = useRef(true)
  const inFlight = useRef(false)
  const notify = useRef(onDirtyChange)
  notify.current = onDirtyChange
  const dirty = loaded !== undefined && value !== loaded.content
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      notify.current?.(false)
    }
  }, [])
  useEffect(() => {
    notify.current?.(dirty || saving)
    if (!dirty && !saving) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty, saving])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit reload discards the draft only after the user chooses it.
  useEffect(() => {
    let current = true
    setLoaded(undefined)
    setError(undefined)
    setConflict(false)
    setSaved(false)
    void getAppRpcClient(apiBase)
      .request("workspace/readForEdit", { cwd, path })
      .then(
        (result) => {
          if (!current) return
          setLoaded(result)
          setValue(result.content)
        },
        (cause: unknown) => {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not open file for editing.",
            )
        },
      )
    return () => {
      current = false
    }
  }, [apiBase, cwd, path, revision])
  const save = async () => {
    if (!loaded || !dirty || inFlight.current || conflict) return
    inFlight.current = true
    setSaving(true)
    setError(undefined)
    const content = value
    try {
      const result = await getAppRpcClient(apiBase).request("workspace/write", {
        cwd,
        path: loaded.path,
        content,
        expectedSha256: loaded.sha256,
      })
      if (!active.current) return
      setLoaded({ ...result, content })
      setSaved(true)
      // File and Git views already refresh on focus. Invalidate them after an
      // in-app save too, without remounting this editor or losing undo history.
      window.dispatchEvent(new Event("yakitori:workspace-file-saved"))
    } catch (cause) {
      if (!active.current) return
      const changed =
        cause instanceof ApiRequestError && cause.code === "conflict"
      setConflict(changed)
      setError(
        changed
          ? "This file changed on disk. Your edits are kept here. Copy them or reload the latest file before saving."
          : cause instanceof Error
            ? cause.message
            : "Could not save file.",
      )
    } finally {
      inFlight.current = false
      if (active.current) setSaving(false)
    }
  }
  return (
    <div className="workspace-file-preview file-editor flex min-h-0 flex-1 flex-col">
      <div className="file-preview-heading">
        <FileCode2 size={18} className="shrink-0 text-muted-foreground" />
        <div className="file-preview-identity">
          <strong>
            {path.split("/").at(-1)}
            {dirty ? " •" : ""}
          </strong>
          <span title={path}>{path}</span>
        </div>
        <button
          type="button"
          className="file-editor-save"
          disabled={!dirty || saving || conflict}
          onClick={() => void save()}
        >
          <Save size={13} /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="file-preview-toolbar">
        <button
          type="button"
          disabled={saving}
          className="file-editor-back"
          onClick={() => (dirty ? setDiscarding(true) : onClose())}
        >
          Back to preview
        </button>
        <div className="file-preview-actions">
          <button
            type="button"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            className="file-editor-icon"
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={15} />
          </button>
          <CopyIconButton text={value} label="file content" />
        </div>
      </div>
      {error ? (
        <div className="file-editor-error" role="alert">
          <p>{error}</p>
          {conflict ? (
            <button type="button" onClick={() => setRevision(revision + 1)}>
              Reload and discard edits
            </button>
          ) : null}
        </div>
      ) : null}
      {loaded ? (
        <Suspense
          fallback={
            <p role="status" className="p-4 text-xs text-muted-foreground">
              Loading editor…
            </p>
          }
        >
          <CodeEditor
            key={revision}
            value={value}
            path={path}
            wrap={wrap}
            onChange={(next) => {
              setValue(next)
              setSaved(false)
            }}
            onSave={() => void save()}
          />
        </Suspense>
      ) : !error ? (
        <p role="status" className="p-4 text-xs text-muted-foreground">
          Loading complete file…
        </p>
      ) : null}
      <div className="file-preview-status">
        <span>
          {dirty
            ? "Unsaved changes"
            : loaded
              ? saved
                ? "Saved"
                : "Editing"
              : "Opening file"}
        </span>
        <span>⌘S / Ctrl+S</span>
      </div>
      {discarding ? (
        <DiscardFileDialog
          name={path.split("/").at(-1) ?? path}
          onCancel={() => setDiscarding(false)}
          onDiscard={onClose}
        />
      ) : null}
    </div>
  )
}

export function DiscardFileDialog({
  name,
  onCancel,
  onDiscard,
}: Readonly<{
  name: string
  onCancel(): void
  onDiscard(): void
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="side-chat-close-dialog"
      aria-labelledby="discard-file-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <h2 id="discard-file-title" className="text-base font-semibold">
        Discard changes to {name}?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Your unsaved edits will be lost.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-sm"
          onClick={onCancel}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="rounded-lg bg-destructive px-3 py-2 text-sm text-white"
          onClick={onDiscard}
        >
          Discard changes
        </button>
      </div>
    </dialog>
  )
}
