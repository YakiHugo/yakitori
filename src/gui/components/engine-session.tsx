import { useEffect, useId, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { inputContent, inputContentText } from "../../protocol/user-input.ts"
import { projectEngineSession } from "../../shared/acp-execution-view.ts"
import { discardDraftAttachments } from "../composer-attachments.ts"
import { useChatInterrupt } from "../hooks/use-chat-interrupt.ts"
import { useAppStore } from "../store/app-store.ts"
import {
  answerEnginePermission,
  cancelEngineTurn,
  chooseNewEngine,
  configureEngineSession,
  selectEngineSession,
  sendEngineInput,
  useEngineStore,
} from "../store/engine-store.ts"
import { presentTool } from "../tool-presentation.ts"
import { ToolDetailView, ToolFileLocations } from "./cells/tool-detail.tsx"
import { ComposerSurface } from "./composer-surface.tsx"
import { ConversationMessages } from "./conversation-messages.tsx"
import {
  type ConversationCapabilities,
  ConversationScopeContext,
} from "./conversation-scope.tsx"
import { ExcerptSourceLayer, requestExcerptEdit } from "./excerpt-source.tsx"
import { SelectionActions } from "./selection-actions.tsx"
import { Select } from "./ui/select.tsx"

export function EngineSelector() {
  const id = useId()
  const engines = useEngineStore((state) => state.engines)
  const engineId = useEngineStore((state) => state.engineId)
  if (!engines.some((engine) => engine.kind === "acp")) return null
  return (
    <label htmlFor={id} className="text-xs text-muted-foreground">
      Engine{" "}
      <Select
        size="sm"
        variant="ghost"
        id={id}
        aria-label="New session engine"
        value={engineId ?? "yakitori"}
        onValueChange={(value) =>
          chooseNewEngine(value === "yakitori" ? "" : value)
        }
        options={engines.map((engine) => ({
          value: engine.id,
          label: `${engine.label}${engine.available ? "" : " (unavailable)"}`,
          disabled: !engine.available,
        }))}
      />
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

export function EngineSessionHeading() {
  const state = useEngineStore()
  const descriptor = state.engines.find(
    (engine) => engine.id === state.engineId,
  )
  const session = state.sessions.find((entry) => entry.id === state.sessionId)
  return (
    <div className="window-session-heading">
      <h2 className="truncate text-sm font-semibold">
        {state.sessionId === undefined
          ? "New session"
          : (state.snapshot?.session.title ??
            session?.title ??
            "Untitled session")}
      </h2>
      <span className="window-engine-label">
        {descriptor?.label ?? state.engineId}
      </span>
    </div>
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
  const [configuring, setConfiguring] = useState(false)
  const promptCapabilities =
    view?.chrome.prompt ?? descriptor?.capabilities.prompt
  const capabilities: ConversationCapabilities = {
    editable: false,
    supportsContextExcerpts: promptCapabilities?.embeddedContext === true,
    historyOwnership: "observed",
  }
  const excerpts = state.draft.references ?? []
  const excerptOwnerId = `engine:${state.sessionId ?? state.engineId}`
  const scroll = useRef<HTMLElement>(null)
  const pinned = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: new observed output changes the scroll height.
  useEffect(() => {
    if (pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [state.snapshot])
  const uncertain =
    (view?.uncertain.length ?? 0) > 0 || state.pendingRequestId !== undefined
  const interrupt = useChatInterrupt({
    sessionId: state.sessionId,
    turnId: view?.activeTurnId,
    stopping: state.stopping,
    onInterrupt: () => {
      if (
        useEngineStore.getState().sessionId === state.sessionId &&
        view?.activeTurnId
      )
        void cancelEngineTurn(view.activeTurnId)
    },
  })
  return (
    <div
      {...interrupt}
      className="engine-conversation flex min-h-0 flex-1 flex-col"
    >
      <section
        ref={scroll}
        onScroll={() => {
          const node = scroll.current
          if (node)
            pinned.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 64
        }}
        className="engine-transcript min-h-0 flex-1 overflow-y-auto px-5"
        aria-label="Engine conversation"
      >
        <div className="mx-auto max-w-3xl space-y-5 py-5">
          <p className="text-xs text-muted-foreground">
            Observed transcript. The engine owns its context.{" "}
            {descriptor?.capabilities.resume || descriptor?.capabilities.load
              ? "Existing engine sessions can reconnect."
              : "This engine does not advertise reconnecting existing sessions."}
          </p>
          <EngineSessionChrome
            chrome={view?.chrome}
            label={descriptor?.label ?? state.engineId}
            disabled={
              configuring || uncertain || view?.activeTurnId !== undefined
            }
            onConfigure={(id, value) => {
              setConfiguring(true)
              void configureEngineSession(id, value).finally(() =>
                setConfiguring(false),
              )
            }}
          />
          {state.loading && <p role="status">Loading conversation…</p>}
          {view === undefined ? null : (
            <ConversationScopeContext.Provider
              value={{
                sessionId: state.sessionId,
                engineId: state.engineId,
                threadId: state.sessionId ?? "",
                apiBase,
                workspaceRoot: state.snapshot?.session.cwd,
                capabilities,
                interactiveQuestions: false,
              }}
            >
              <ConversationMessages
                view={view.executionView}
                capabilities={capabilities}
              />
            </ConversationScopeContext.Provider>
          )}
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
          {permission.tool === undefined ? null : (
            <>
              <ToolFileLocations
                locations={permission.tool.locations}
                workspaceRoot={state.snapshot?.session.cwd}
              />
              <ToolDetailView
                detail={presentTool(permission.tool).detail}
                workspaceRoot={state.snapshot?.session.cwd}
              />
            </>
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
      {capabilities.supportsContextExcerpts && state.sessionId !== undefined ? (
        <>
          <ExcerptSourceLayer
            items={excerpts.map((excerpt, index) => ({
              excerpt,
              number: index + 1,
              ownerId: excerptOwnerId,
              conversation: "engine conversation",
            }))}
          />
          <SelectionActions
            sourceRoot={scroll}
            onAddToConversation={(excerpt) => {
              if (useEngineStore.getState().sessionId !== state.sessionId)
                return
              flushSync(() =>
                useEngineStore.setState(({ draft }) => ({
                  draft: inputContent(draft, [
                    ...(draft.references ?? []),
                    excerpt,
                  ]),
                })),
              )
              requestExcerptEdit({
                ownerId: excerptOwnerId,
                excerptId: excerpt.id,
                creating: true,
              })
            }}
          />
        </>
      ) : null}
      <ComposerSurface
        sessionId={state.sessionId}
        editorKey={state.sessionId ?? state.engineId}
        draft={state.draft}
        excerptOwnerId={excerptOwnerId}
        excerpts={excerpts}
        sessionSkills={[]}
        apiBase={apiBase}
        historyParts={[]}
        setPromptDraft={(draft) =>
          useEngineStore.setState((current) => ({
            draft: inputContent(draft, current.draft.references),
          }))
        }
        removePromptExcerpt={(id) =>
          useEngineStore.setState(({ draft }) => ({
            draft: inputContent(
              draft,
              draft.references?.filter((excerpt) => excerpt.id !== id),
            ),
          }))
        }
        updatePromptExcerpt={(excerpt) =>
          useEngineStore.setState(({ draft }) => ({
            draft: inputContent(
              draft,
              draft.references?.map((current) =>
                current.id === excerpt.id ? excerpt : current,
              ),
            ),
          }))
        }
        onSubmit={(draft) => {
          if (!view?.activeTurnId && !uncertain) {
            const content = inputContent(
              draft,
              excerpts.length > 0 ? excerpts : undefined,
            )
            void sendEngineInput(
              inputContentText(content),
              content.attachments.length > 0 || excerpts.length > 0
                ? content
                : undefined,
            )
          }
        }}
        onCancel={() => {
          if (view?.activeTurnId) void cancelEngineTurn(view.activeTurnId)
        }}
        modelControls={null}
        importAttachments={async (prepare, validate) => {
          if (
            !promptCapabilities?.image &&
            !promptCapabilities?.embeddedContext
          )
            return
          validate?.()
          const prepared = await prepare()
          if (prepared === undefined) return
          try {
            const attachments = await prepared.collect(state.sessionId)
            const unsupported = attachments.filter((attachment) =>
              attachment.mediaType === "application/pdf"
                ? !promptCapabilities.embeddedContext
                : !promptCapabilities.image,
            )
            if (unsupported.length > 0) {
              await discardDraftAttachments(attachments, apiBase)
              throw new Error(
                "An attachment type is unavailable in this engine.",
              )
            }
            return attachments
          } finally {
            await prepared.cleanup?.()
          }
        }}
        readingAttachments={false}
        onAttachmentError={(error) => useEngineStore.setState({ error })}
        allowCommands={false}
        engineCommands={view?.chrome.commands}
        allowAttachments={
          promptCapabilities?.image === true ||
          promptCapabilities?.embeddedContext === true
        }
        supportsImages={promptCapabilities?.image === true}
        busy={
          state.loading ||
          configuring ||
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

function EngineSessionChrome({
  chrome,
  label,
  disabled,
  onConfigure,
}: Readonly<{
  chrome: ReturnType<typeof projectEngineSession>["chrome"] | undefined
  label: string | undefined
  disabled: boolean
  onConfigure(id: string, value: string): void
}>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chrome?.controls.length ? (
        chrome.controls.map((control) => (
          <Select
            key={control.id}
            size="sm"
            variant="ghost"
            aria-label={control.label}
            value={control.value}
            options={control.options}
            disabled={disabled}
            onValueChange={(value) => onConfigure(control.id, value)}
          />
        ))
      ) : (
        <span className="text-xs text-muted-foreground">
          {label} · Engine-managed model
        </span>
      )}
      {chrome?.usage === undefined ? null : (
        <span
          className="text-xs text-muted-foreground"
          title="Engine context usage"
        >
          {chrome.usage.used.toLocaleString()} /{" "}
          {chrome.usage.size.toLocaleString()} tokens
        </span>
      )}
    </div>
  )
}
