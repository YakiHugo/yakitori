import {
  ArrowDownToLine,
  LoaderCircle,
  RotateCw,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { DesktopUpdateState } from "../../protocol/desktop-update.ts"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"
import "../styles/app-update.css"

type UpdateAction = "getState" | "check" | "download" | "install"
type TransportError = { message: string; retry: UpdateAction }

export function AppUpdate() {
  const bridge = window.yakitoriDesktop?.updates
  const [state, setState] = useState<DesktopUpdateState>()
  const [error, setError] = useState<TransportError>()
  const [pending, setPending] = useState<UpdateAction>()
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()
  const revision = useRef(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const open = anchor !== undefined

  useEffect(() => {
    if (!bridge) return
    let active = true
    const unsubscribe = bridge.onState((next) => {
      revision.current += 1
      setState(next)
      setError(undefined)
    })
    const requestedRevision = revision.current
    void bridge.getState().then(
      (next) => {
        if (active && revision.current === requestedRevision) setState(next)
      },
      (failure: unknown) => {
        if (active && revision.current === requestedRevision)
          setError({
            message:
              failure instanceof Error
                ? failure.message
                : "Could not load update status.",
            retry: "getState",
          })
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  const visible =
    bridge !== undefined &&
    (error !== undefined ||
      (state !== undefined &&
        state.phase !== "idle" &&
        state.phase !== "checking" &&
        state.phase !== "unavailable"))

  useEffect(() => {
    if (!visible) setAnchor(undefined)
  }, [visible])

  useEffect(() => {
    if (!open || !visible) return
    panel.current?.focus()
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setAnchor(undefined)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (!isUnmodifiedEscape(event)) return
      event.preventDefault()
      event.stopPropagation()
      setAnchor(undefined)
      trigger.current?.focus()
    }
    const dismissResize = () => setAnchor(undefined)
    document.addEventListener("pointerdown", dismissOutside)
    document.addEventListener("focusin", dismissOutside)
    document.addEventListener("keydown", dismissEscape)
    window.addEventListener("resize", dismissResize)
    return () => {
      document.removeEventListener("pointerdown", dismissOutside)
      document.removeEventListener("focusin", dismissOutside)
      document.removeEventListener("keydown", dismissEscape)
      window.removeEventListener("resize", dismissResize)
    }
  }, [open, visible])

  if (!visible || !bridge) return null

  const run = async (action: UpdateAction) => {
    const requestedRevision = revision.current
    setPending(action)
    try {
      const next = await bridge[action]()
      if (revision.current === requestedRevision) {
        setError(undefined)
        if (action === "getState" && next) setState(next)
      }
    } catch (failure) {
      // Bridge rejections are transport failures; updater failures arrive as state.
      if (revision.current === requestedRevision)
        setError({
          message:
            failure instanceof Error
              ? failure.message
              : "Could not complete the update request.",
          retry: action,
        })
    } finally {
      setPending(undefined)
    }
  }

  const failed = error !== undefined || state?.phase === "error"
  const message =
    error?.message ?? (state?.phase === "error" ? state.message : "")
  const retry =
    error?.retry ?? (state?.phase === "error" ? state.retry : undefined)
  const ready = state?.phase === "ready"
  const busy =
    pending !== undefined ||
    state?.phase === "downloading" ||
    state?.phase === "preparing" ||
    state?.phase === "installing"
  const title = failed
    ? "Update failed"
    : ready
      ? "Restart to update"
      : state?.phase === "downloading"
        ? "Downloading update"
        : state?.phase === "preparing"
          ? "Preparing update"
          : state?.phase === "installing"
            ? "Installing update"
            : "Update available"
  const current = state && "current" in state ? state.current : undefined
  const release = state && "release" in state ? state.release : undefined
  const percent =
    state?.phase === "downloading" && state.totalBytes > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((state.downloadedBytes / state.totalBytes) * 100),
          ),
        )
      : undefined

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="window-rail-button app-update-trigger"
        data-error={failed}
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={state?.phase === "installing"}
        onClick={() => {
          if (open) setAnchor(undefined)
          else {
            const rect = trigger.current?.getBoundingClientRect()
            if (rect)
              setAnchor({
                left: rect.right + 10,
                bottom: Math.max(12, window.innerHeight - rect.bottom),
              })
          }
        }}
      >
        {failed ? (
          <TriangleAlert size={19} />
        ) : busy ? (
          <span className="app-update-spinner">
            <LoaderCircle size={19} />
          </span>
        ) : ready ? (
          <RotateCw size={19} />
        ) : (
          <ArrowDownToLine size={19} />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="app-update-popover"
            style={anchor}
          >
            <h2 id={titleId}>{title}</h2>
            {current && (
              <dl className="app-update-builds">
                <div>
                  <dt>Current</dt>
                  <dd>
                    {current.commit.slice(0, 7)} · Build {current.buildNumber}
                  </dd>
                </div>
                {release && (
                  <div>
                    <dt>New</dt>
                    <dd>
                      {release.commit.slice(0, 7)} · Build {release.buildNumber}
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {current?.channel === "local" && current.dirty && (
              <p className="app-update-warning">
                This local build has uncommitted changes. Updating replaces this
                local build.
              </p>
            )}
            {failed ? (
              <>
                <p role="alert" className="app-update-warning">
                  {message}
                </p>
                <button
                  type="button"
                  className="app-update-action"
                  disabled={pending !== undefined}
                  onClick={() => {
                    if (retry) void run(retry)
                  }}
                >
                  {pending ? "Retrying…" : "Retry"}
                </button>
              </>
            ) : ready ? (
              <>
                <p>
                  The update is ready. Restart Yakitori to finish installing.
                </p>
                <button
                  type="button"
                  className="app-update-action"
                  disabled={pending !== undefined}
                  onClick={() => void run("install")}
                >
                  Restart and update
                </button>
              </>
            ) : busy ? (
              <div className="app-update-progress">
                <p role="status">
                  {state?.phase === "downloading"
                    ? `Downloading update${percent === undefined ? "…" : ` · ${percent}%`}`
                    : state?.phase === "installing"
                      ? "Restarting Yakitori…"
                      : "Preparing update…"}
                </p>
                <progress aria-label={title} max={100} value={percent} />
              </div>
            ) : (
              <button
                type="button"
                className="app-update-action"
                onClick={() => void run("download")}
              >
                Download update
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
