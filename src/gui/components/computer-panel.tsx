import { Check, LoaderCircle, Monitor, RefreshCw, Unplug } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { ComputerUseStatus } from "../../server/computer-use.ts"
import { imageAttachmentUrl } from "../composer-attachments.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { useAppStore } from "../store/app-store.ts"
import { ImageLightbox } from "./image-lightbox.tsx"

export function ComputerPanel({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<ComputerUseStatus>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState(false)
  const screenshot = useAppStore((state) => {
    for (let index = state.execution.entries.length - 1; index >= 0; index--) {
      const entry = state.execution.entries[index]
      if (
        entry &&
        entry.kind === "tool" &&
        entry.execution.name.includes("cua_repl") &&
        (entry.attachments?.length ?? 0) > 0
      )
        return entry
    }
    return undefined
  })
  const image =
    screenshot?.kind === "tool" ? screenshot.attachments?.at(-1) : undefined
  const run = useCallback(
    async (
      method: "computer/status" | "computer/connect" | "computer/disconnect",
    ) => {
      setPending(true)
      setError(undefined)
      try {
        setStatus(await getAppRpcClient(apiBase).request(method, {}))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setPending(false)
      }
    },
    [apiBase],
  )
  useEffect(() => {
    void run("computer/status")
  }, [run])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 text-xs">
          <span
            className={`size-1.5 rounded-full ${status?.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          />
          {status?.connected ? "Connected" : "Not connected"}
        </span>
        <button
          type="button"
          className="sidebar-icon"
          aria-label="Refresh computer connection"
          disabled={pending}
          onClick={() => void run("computer/status")}
        >
          <RefreshCw
            size={14}
            className={pending ? "animate-spin" : undefined}
          />
        </button>
      </div>
      <div className="space-y-5 p-5">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl border bg-muted/40">
            <Monitor size={21} strokeWidth={1.5} />
          </div>
          <div>
            <h3 className="text-sm font-medium">Computer use</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Work with apps on your Mac
            </p>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Let Yakitori inspect apps, click, type, and verify what happens on
          screen. Describe the app and task in your conversation to get started.
        </p>
        {status?.message && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {status.message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={pending || (!status?.available && !status?.connected)}
          onClick={() =>
            void run(
              status?.connected ? "computer/disconnect" : "computer/connect",
            )
          }
          className="flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {pending ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : status?.connected ? (
            <Unplug size={14} />
          ) : (
            <Monitor size={14} />
          )}
          {pending
            ? "Checking connection…"
            : status?.connected
              ? "Disconnect"
              : "Connect computer"}
        </button>
        {status?.available && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Disconnect prevents new actions. Use Stop in the conversation to
            interrupt a running task.
          </p>
        )}
        {status?.connected && (
          <div className="space-y-3 border-t pt-4">
            <p className="flex items-center gap-2 text-xs">
              <Check size={14} /> Ready for your next message
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              If macOS requests access, enable Screen Recording and
              Accessibility for Codex Computer Use in System Settings.
            </p>
          </div>
        )}
      </div>
      <div className="mt-auto border-t p-4">
        <p className="mb-3 text-[11px] font-medium text-muted-foreground">
          LATEST CAPTURE · THIS CONVERSATION
        </p>
        {image ? (
          <button
            type="button"
            aria-label="Enlarge computer screenshot"
            onClick={() => setPreview(true)}
            className="block w-full rounded-lg border bg-muted/30 p-1"
          >
            <img
              src={imageAttachmentUrl(image, apiBase)}
              alt={image.name}
              className="max-h-72 w-full rounded object-contain"
            />
          </button>
        ) : (
          <div className="rounded-lg border border-dashed px-5 py-9 text-center text-xs leading-relaxed text-muted-foreground">
            Screenshots from computer actions will appear here.
          </div>
        )}
      </div>
      {preview && image && (
        <ImageLightbox
          src={imageAttachmentUrl(image, apiBase)}
          name={image.name}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  )
}
