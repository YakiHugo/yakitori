import { useEffect, useMemo, useRef, useState } from "react"
import { inputContent, inputContentText } from "../../protocol/user-input.ts"
import { projectEngineSession } from "../engine-session-view.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  answerEnginePermission,
  cancelEngineTurn,
  chooseNewEngine,
  selectEngineSession,
  sendEngineInput,
  useEngineStore,
} from "../store/engine-store.ts"
import { ComposerSurface } from "./composer-surface.tsx"
import { MarkdownView } from "./markdown.tsx"

export function EngineSelector() {
  const engines = useEngineStore((state) => state.engines)
  const engineId = useEngineStore((state) => state.engineId)
  if (!engines.some((engine) => engine.kind === "acp")) return null
  return (
    <label className="text-xs text-muted-foreground">
      Engine{" "}
      <select
        aria-label="New session engine"
        className="rounded-md border bg-background px-3 py-1.5 text-foreground"
        value={engineId ?? "yakitori"}
        onChange={(event) =>
          chooseNewEngine(
            event.target.value === "yakitori" ? "" : event.target.value,
          )
        }
      >
        {engines.map((engine) => (
          <option
            key={engine.id}
            value={engine.id}
            disabled={!engine.available}
          >
            {engine.label}
            {!engine.available ? " (unavailable)" : ""}
          </option>
        ))}
      </select>
    </label>
  )
}

export function EngineSessionItems() {
  const sessions = useEngineStore((state) => state.sessions)
  const selected = useEngineStore((state) => state.sessionId)
  if (sessions.length === 0) return null
  return (
    <section aria-label="External engine sessions" className="mt-4">
      <h2 className="px-2 py-1 text-xs text-muted-foreground">
        External engines
      </h2>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          className="sidebar-row w-full text-left"
          aria-current={selected === session.id ? "page" : undefined}
          onClick={() => void selectEngineSession(session)}
        >
          <span className="truncate">
            {session.title ?? "Untitled session"}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {session.engineId}
          </span>
        </button>
      ))}
    </section>
  )
}

export function EngineConversation() {
  const state = useEngineStore()
  const apiBase = useAppStore((app) => app.apiBase)
  const descriptor = state.engines.find(
    (engine) => engine.id === state.engineId,
  )
  const view = useMemo(
    () =>
      state.snapshot === undefined
        ? undefined
        : projectEngineSession(state.snapshot),
    [state.snapshot],
  )
  const [permissionBusy, setPermissionBusy] = useState<string>()
  const scroll = useRef<HTMLElement>(null)
  const pinned = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: new observed output changes the scroll height.
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [state.snapshot])
  const uncertain =
    (view?.uncertain.length ?? 0) > 0 || state.pendingRequestId !== undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state.sessionId !== undefined && (
        <header className="session-header flex h-12 shrink-0 items-center justify-between border-b px-5">
          <h2 className="truncate text-sm font-semibold">
            {state.snapshot?.session.title ?? "Untitled session"}
          </h2>
          <span className="text-xs text-muted-foreground">
            {descriptor?.label ?? state.engineId}
          </span>
        </header>
      )}
      <section
        ref={scroll}
        onScroll={() => {
          const node = scroll.current
          if (node)
            pinned.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 64
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5"
        aria-label="Engine conversation"
      >
        <div className="mx-auto max-w-3xl space-y-5 py-5">
          <p className="text-xs text-muted-foreground">
            Observed transcript. The engine owns its context.{" "}
            {descriptor?.capabilities.resume || descriptor?.capabilities.load
              ? "Existing engine sessions can reconnect."
              : "This engine does not advertise reconnecting existing sessions."}
          </p>
          {state.loading && <p role="status">Loading conversation…</p>}
          {view?.turns.map((turn) => (
            <article key={turn.id} className="space-y-3">
              {turn.input && (
                <div className="message-bubble whitespace-pre-wrap rounded-xl bg-muted p-3">
                  {turn.input}
                </div>
              )}
              {turn.reasoning && (
                <details>
                  <summary className="text-xs text-muted-foreground">
                    Reasoning
                  </summary>
                  <MarkdownView
                    text={turn.reasoning}
                    workspaceRoot={state.snapshot?.session.cwd}
                  />
                </details>
              )}
              {turn.assistant && (
                <section aria-label="Response">
                  <MarkdownView
                    text={turn.assistant}
                    workspaceRoot={state.snapshot?.session.cwd}
                    streaming={view.activeTurnId === turn.id}
                  />
                </section>
              )}
              {turn.updates.length > 0 && (
                <details>
                  <summary className="text-xs text-muted-foreground">
                    Engine activity
                  </summary>
                  <pre className="overflow-auto text-xs">
                    {JSON.stringify(turn.updates, null, 2)}
                  </pre>
                </details>
              )}
              {turn.status && (
                <p className="text-xs text-muted-foreground">{turn.status}</p>
              )}
            </article>
          ))}
          {view?.uncertain.map((request) => (
            <div
              key={request.requestId}
              role="alert"
              className="rounded-xl border border-amber-300 p-3 text-sm"
            >
              <p className="whitespace-pre-wrap">{request.input.text}</p>
              <p>
                {request.status === "unknown"
                  ? "The engine's outcome is unknown. This input will not be sent again automatically."
                  : "Waiting for the engine to acknowledge this input."}
              </p>
            </div>
          ))}
        </div>
      </section>
      {state.pendingRequestId !== undefined &&
        !view?.uncertain.some(
          (request) => request.requestId === state.pendingRequestId,
        ) && (
          <p role="status" className="px-5 py-2 text-sm">
            Input acknowledgement is pending. It will not be sent again
            automatically.
          </p>
        )}
      {state.error && (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {view?.permissions.map((permission) => (
        <fieldset
          key={permission.requestId}
          aria-label={`Permission · ${permission.description}`}
          className="border-t bg-amber-50 px-5 py-3 dark:bg-amber-950/40"
        >
          <legend className="text-sm">{permission.description}</legend>
          {permission.toolCall && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(permission.toolCall, null, 2)}
            </pre>
          )}
          <div className="flex gap-2">
            {permission.options.map((option) => (
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm"
                key={option.id}
                disabled={permissionBusy === permission.requestId}
                onClick={() => {
                  setPermissionBusy(permission.requestId)
                  void answerEnginePermission(
                    permission.turnId,
                    permission.requestId,
                    option.id,
                  ).finally(() => setPermissionBusy(undefined))
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <ComposerSurface
        sessionId={state.sessionId}
        editorKey={state.sessionId ?? state.engineId}
        draft={state.draft}
        excerpts={[]}
        sessionSkills={[]}
        apiBase={apiBase}
        historyParts={[]}
        setPromptDraft={(draft) => useEngineStore.setState({ draft })}
        removePromptExcerpt={() => {}}
        updatePromptExcerpt={() => {}}
        onSubmit={(draft) => {
          if (!view?.activeTurnId && !uncertain)
            void sendEngineInput(inputContentText(inputContent(draft)))
        }}
        onCancel={() => {
          if (view?.activeTurnId) void cancelEngineTurn(view.activeTurnId)
        }}
        modelControls={
          <span className="text-xs text-muted-foreground">
            {descriptor?.label ?? state.engineId} · Engine-managed model
          </span>
        }
        importAttachments={async () => {
          useEngineStore.setState({
            error: "This engine connection currently accepts text only.",
          })
          return undefined
        }}
        readingAttachments={false}
        onAttachmentError={(error) => useEngineStore.setState({ error })}
        allowCommands={false}
        allowAttachments={false}
        supportsImages={false}
        busy={
          state.loading ||
          uncertain ||
          descriptor?.available === false ||
          view?.activeTurnId !== undefined
        }
        sending={state.sending}
        stopping={state.stopping}
        activeTurnId={view?.activeTurnId}
      />
    </div>
  )
}
