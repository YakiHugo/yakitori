import { useMemo } from "react"
import { create } from "zustand"
import {
  COMPACT_DIRECTIVE,
  type ImageAttachment,
  isKernelEvent,
  type ModelSelection,
  type StoredEventEnvelope,
} from "../../kernel/events.ts"
import { createRequestId } from "../../kernel/ids.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type {
  ApiAdmitInputResponse,
  ApiCompactSessionResponse,
  ApiCreateSessionResponse,
  ApiForkSessionResponse,
  ApiListProjectsResponse,
  ApiListProvidersResponse,
  ApiListSessionsResponse,
  ApiPendingPermission,
  ApiProviderSummary,
  ApiSessionDetail,
  ApiSessionSummary,
  ApiUpdateUserModelPreferenceResponse,
  ApiUserModelPreference,
} from "../../server/protocol.ts"
import { acknowledgeAdmission, reserveAdmission } from "../admission-outbox.ts"
import {
  createExecutionViewState,
  type ExecutionView,
  type ExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../execution-view.ts"
import {
  ApiRequestError,
  cancelSessionInput,
  openSessionEventStream,
  requestJson,
} from "../lib/api-client.ts"

type SessionSelection = {
  readonly revision: number
  readonly sessionId: string
}

export type AppStoreData = {
  apiBase: string
  busy: boolean
  composerFocusRevision: number
  defaultModel: string | undefined
  defaultProvider: string | undefined
  execution: ExecutionViewState
  inFlightActions: ReadonlySet<string>
  message: string | undefined
  modelSelections: Record<string, ModelSelection>
  restoringModelSelectionFor: string | undefined
  nextCursor: string | undefined
  // TODO(gui-session-state): Move composer text and staged attachments into
  // Session-scoped UI state when the GUI shell is redesigned. The current
  // single active draft is intentionally temporary; do not expand it into a
  // persistence or attachment-lifecycle authority.
  promptDraft: string | undefined
  promptAttachments: readonly ImageAttachment[]
  projects: string[]
  providers: ApiProviderSummary[]
  userPreference: ApiUserModelPreference | undefined
  selection: { readonly sessionId?: string }
  sessionSelectionIntentRevision: number
  selectedSession: ApiSessionDetail | undefined
  sessions: ApiSessionSummary[]
  stream: EventSource | undefined
  currentProject: string | undefined
}

export type AppStoreActions = {
  boot(): Promise<void>
  loadSessions(input?: { readonly append?: boolean }): Promise<boolean>
  loadProjects(): Promise<void>
  loadProviders(): Promise<void>
  createSession(): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  forkSession(
    atInputId: string,
    reason: "undo" | "edit",
    content?: string,
  ): Promise<void>
  selectProject(path: string): Promise<void>
  addProject(path: string): Promise<void>
  selectSession(sessionId: string): Promise<void>
  admitInput(
    text: string,
    attachments?: readonly ImageAttachment[],
  ): Promise<void>
  cancelTurn(turnId: string): Promise<void>
  cancelQueuedInput(inputId: string): Promise<void>
  resolvePermission(
    turnId: string,
    permissionRequestId: string,
    behavior: "allow" | "deny",
  ): Promise<void>
  setPromptDraft(text: string): void
  setPromptAttachments(attachments: readonly ImageAttachment[]): void
  setModelSelection(
    sessionId: string,
    selection: ModelSelection | undefined,
  ): void
}

export type AppStore = AppStoreData & AppStoreActions

export function createInitialAppState(): AppStoreData {
  return {
    apiBase: initialApiBase(),
    busy: false,
    composerFocusRevision: 0,
    defaultModel: undefined,
    defaultProvider: undefined,
    execution: createExecutionViewState(),
    inFlightActions: new Set(),
    message: undefined,
    modelSelections: initialModelSelections(),
    restoringModelSelectionFor: undefined,
    nextCursor: undefined,
    promptDraft: undefined,
    promptAttachments: [],
    projects: [],
    providers: [],
    userPreference: undefined,
    selection: {},
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessions: [],
    stream: undefined,
    currentProject: undefined,
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  let sessionListRevision = 0
  const runTask = async (
    task: () => Promise<void>,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> => {
    activeTaskCount += 1
    set({ busy: true })
    if (isCurrent()) set({ message: undefined })
    try {
      await task()
      return true
    } catch (error) {
      if (isCurrent()) set({ message: errorMessage(error, "Request failed.") })
      return false
    } finally {
      activeTaskCount -= 1
      set({ busy: activeTaskCount > 0 })
    }
  }

  const activateSession = (sessionId: string): SessionSelection => {
    set({ selection: { sessionId } })
    return {
      revision: get().sessionSelectionIntentRevision,
      sessionId,
    }
  }

  const currentSelection = (): SessionSelection | undefined => {
    const sessionId = get().selection.sessionId
    if (sessionId === undefined) return
    return {
      revision: get().sessionSelectionIntentRevision,
      sessionId,
    }
  }

  const isCurrentSelection = (selection: SessionSelection): boolean =>
    get().sessionSelectionIntentRevision === selection.revision &&
    get().selection.sessionId === selection.sessionId

  const closeStream = (): void => {
    get().stream?.close()
    set({ stream: undefined })
  }

  const connectEvents = (selection: SessionSelection, after: number): void => {
    if (!isCurrentSelection(selection)) return
    closeStream()

    try {
      const source = openSessionEventStream(
        get().apiBase,
        selection.sessionId,
        after,
        {
          onSnapshot: (response) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            let modelSelections = get().modelSelections
            let restoringModelSelectionFor = get().restoringModelSelectionFor
            if (
              restoringModelSelectionFor === selection.sessionId &&
              response.session.currentModel !== undefined
            ) {
              modelSelections = {
                ...modelSelections,
                [selection.sessionId]: response.session.currentModel,
              }
              persistModelSelections(modelSelections)
              restoringModelSelectionFor = undefined
            }
            set({
              selectedSession: response.session,
              modelSelections,
              restoringModelSelectionFor,
              execution: reduceExecutionView(get().execution, {
                type: "snapshot",
                session: response.session,
              }),
            })
          },
          onReplayComplete: () => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            if (get().restoringModelSelectionFor === selection.sessionId) {
              set({ restoringModelSelectionFor: undefined })
            }
          },
          onEvent: (event) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            set((state) => {
              const selectedSession = applyDurableSessionDetail(
                state.selectedSession,
                event,
              )
              return {
                selectedSession,
                sessions: updateSessionSummary(state.sessions, selectedSession),
                execution: reduceExecutionView(state.execution, {
                  type: "durable",
                  event,
                }),
              }
            })
          },
          onTransient: (event) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            set((state) => ({
              selectedSession: applyTransientSessionDetail(
                state.selectedSession,
                event,
              ),
              execution: reduceExecutionView(state.execution, {
                type: "transient",
                event,
              }),
            }))
          },
        },
      )
      set({ stream: source })
    } catch (error) {
      closeStream()
      if (!isCurrentSelection(selection)) return
      set({ message: errorMessage(error, "Could not open event stream.") })
    }
  }

  return {
    ...createInitialAppState(),

    boot: async () => {
      const intentRevision = get().sessionSelectionIntentRevision
      await get().loadProviders()
      await get().loadProjects()
      const loaded = await get().loadSessions()
      if (!loaded || get().sessionSelectionIntentRevision !== intentRevision) {
        return
      }
      const session = get().sessions.at(0)
      if (session) {
        await get().selectSession(session.id)
        return
      }
      closeStream()
      set({
        selection: {},
        selectedSession: undefined,
        execution: createExecutionViewState(),
      })
    },

    loadSessions: async (input = {}) => {
      const requestRevision = ++sessionListRevision
      const existingSessions = get().sessions
      const cursor = input.append ? get().nextCursor : undefined
      const workingDirectory = get().currentProject
      let applied = false
      const completed = await runTask(
        async () => {
          const response = await requestJson<ApiListSessionsResponse>(
            get().apiBase,
            `/sessions?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${workingDirectory === undefined ? "" : `&workingDirectory=${encodeURIComponent(workingDirectory)}`}`,
          )
          if (
            get().currentProject !== workingDirectory ||
            sessionListRevision !== requestRevision
          ) {
            return
          }
          set({
            sessions: input.append
              ? [...existingSessions, ...response.sessions]
              : [...response.sessions],
            nextCursor: response.nextCursor,
          })
          applied = true
        },
        () =>
          get().currentProject === workingDirectory &&
          sessionListRevision === requestRevision,
      )
      return completed && applied
    },

    loadProjects: async () => {
      try {
        const response = await requestJson<ApiListProjectsResponse>(
          get().apiBase,
          "/projects",
        )
        const projects = [...response.projects]
        const current = get().currentProject
        const remembered = window.localStorage.getItem("yakitori.project")
        const currentProject =
          current !== undefined && projects.includes(current)
            ? current
            : remembered !== null && projects.includes(remembered)
              ? remembered
              : projects[0]
        set({
          projects,
          ...(currentProject === undefined ? {} : { currentProject }),
        })
      } catch {
        // Older servers without the projects route return 404; project state
        // stays empty and the switcher stays hidden.
      }
    },

    loadProviders: async () => {
      const apiBase = get().apiBase
      try {
        const response = await requestJson<ApiListProvidersResponse>(
          apiBase,
          "/providers",
        )
        set({
          providers: [...response.providers],
          defaultProvider: response.defaultProvider,
          defaultModel: response.defaultModel,
          userPreference: response.userPreference,
        })
      } catch {
        // Older servers without the providers route return 404; the model
        // selector stays hidden.
      }
    },

    createSession: async () => {
      const intentRevision = get().sessionSelectionIntentRevision + 1
      set({ sessionSelectionIntentRevision: intentRevision })
      await runTask(
        async () => {
          const response = await requestJson<ApiCreateSessionResponse>(
            get().apiBase,
            "/sessions",
            {
              method: "POST",
              body: {
                title: `Session ${new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`,
                ...(get().currentProject === undefined
                  ? {}
                  : { workingDirectory: get().currentProject }),
              },
            },
          )

          await get().loadSessions()
          if (get().sessionSelectionIntentRevision !== intentRevision) return
          const selection = activateSession(response.session.id)
          set({
            selectedSession: response.session,
            execution: reduceExecutionView(createExecutionViewState(), {
              type: "durable",
              event: response.event,
            }),
            promptDraft: undefined,
            promptAttachments: [],
          })
          connectEvents(selection, response.event.seq)
        },
        () => get().sessionSelectionIntentRevision === intentRevision,
      )
    },

    forkSession: async (atInputId, reason, content) => {
      const current = currentSelection()
      if (!current) return
      const key = `fork:${current.sessionId}:${atInputId}`
      if (get().inFlightActions.has(key)) return
      const intentRevision = get().sessionSelectionIntentRevision + 1
      const sourceSelection = { ...current, revision: intentRevision }
      const state = get()
      const sourceModelSelection = normalizeKimiModelSelection(
        resolveEffectiveModel({
          sessionCurrent: state.modelSelections[sourceSelection.sessionId],
          userPreference: state.userPreference,
          defaultProvider: state.defaultProvider,
          defaultModel: state.defaultModel,
        }),
        state.providers,
      )
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
        sessionSelectionIntentRevision: intentRevision,
      }))

      await runTask(
        async () => {
          const response = await requestJson<ApiForkSessionResponse>(
            get().apiBase,
            `/sessions/${encodeURIComponent(sourceSelection.sessionId)}/fork`,
            {
              method: "POST",
              body: {
                atInputId,
                reason,
                ...(content === undefined
                  ? {}
                  : {
                      content: {
                        kind: "text",
                        text: content,
                      },
                    }),
                ...(reason !== "edit" || sourceModelSelection === undefined
                  ? {}
                  : { modelSelection: sourceModelSelection }),
              },
            },
          )
          if (
            get().sessionSelectionIntentRevision !== intentRevision ||
            !isCurrentSelection(sourceSelection)
          ) {
            return
          }
          if (sourceModelSelection !== undefined) {
            get().setModelSelection(response.session.id, sourceModelSelection)
          }

          const selection = activateSession(response.session.id)
          closeStream()
          set((state) => ({
            selectedSession: response.session,
            execution: response.events.reduce(
              (execution, event) =>
                reduceExecutionView(execution, {
                  type: "durable",
                  event,
                }),
              createExecutionViewState(response.session),
            ),
            promptDraft: undefined,
            promptAttachments: [],
            composerFocusRevision: state.composerFocusRevision + 1,
          }))
          connectEvents(
            selection,
            response.events.at(-1)?.seq ?? response.session.seq,
          )
          await get().loadSessions()
        },
        () => get().sessionSelectionIntentRevision === intentRevision,
      )

      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    deleteSession: async (sessionId) => {
      const key = `delete:${sessionId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(async () => {
        await requestJson(
          get().apiBase,
          `/sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        )
        if (get().selection.sessionId === sessionId) {
          closeStream()
          set((state) => ({
            selection: {},
            sessionSelectionIntentRevision:
              state.sessionSelectionIntentRevision + 1,
            selectedSession: undefined,
            execution: createExecutionViewState(),
          }))
        }
        await get().loadSessions()
      })
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    selectProject: async (path) => {
      if (get().currentProject === path) return
      set({ currentProject: path })
      window.localStorage.setItem("yakitori.project", path)
      closeStream()
      set((state) => ({
        selection: {},
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        selectedSession: undefined,
        execution: createExecutionViewState(),
        nextCursor: undefined,
        promptDraft: undefined,
        promptAttachments: [],
      }))
      await get().loadSessions()
    },

    addProject: async (path) => {
      const trimmed = path.trim()
      if (trimmed === "") return
      await runTask(async () => {
        const previous = get().projects
        const response = await requestJson<ApiListProjectsResponse>(
          get().apiBase,
          "/projects",
          { method: "POST", body: { path: trimmed } },
        )
        const projects = [...response.projects]
        set({ projects })
        // The response carries only the list; the previously unknown entry is
        // the server's resolved realpath for the added project.
        const added = projects.find(
          (candidate) => !previous.includes(candidate),
        )
        await get().selectProject(added ?? trimmed)
      })
    },

    selectSession: async (sessionId) => {
      set((state) => ({
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
      }))
      set({
        restoringModelSelectionFor:
          get().modelSelections[sessionId] === undefined
            ? sessionId
            : undefined,
      })
      const selection = activateSession(sessionId)
      closeStream()
      set({
        execution: createExecutionViewState(),
        promptDraft: undefined,
        promptAttachments: [],
        selectedSession: undefined,
      })
      connectEvents(selection, 0)
    },

    admitInput: async (text, attachments = []) => {
      const selection = currentSelection()
      if (
        !selection ||
        get().restoringModelSelectionFor === selection.sessionId
      )
        return
      const key = `admit:${selection.sessionId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))

      // The compact directive takes a dedicated lane: no admission outbox,
      // no model selection — the server admits it as a runtime-role Input.
      // A per-invocation requestId keeps a retried POST from admitting a
      // duplicate compact directive.
      if (text === COMPACT_DIRECTIVE) {
        await runTask(
          async () => {
            const response = await requestJson<ApiCompactSessionResponse>(
              get().apiBase,
              `/sessions/${encodeURIComponent(selection.sessionId)}/compact`,
              {
                method: "POST",
                body: JSON.stringify({ requestId: createRequestId() }),
              },
            )
            if (response.event.sessionId !== selection.sessionId) {
              throw new Error("Compact response did not match the request.")
            }
            if (!isCurrentSelection(selection)) return
            if (
              (get().promptDraft ?? "").trim() === text &&
              sameAttachments(get().promptAttachments, attachments)
            ) {
              set({ promptDraft: undefined, promptAttachments: [] })
            }
          },
          () => isCurrentSelection(selection),
        )
        set((state) => {
          const inFlightActions = new Set(state.inFlightActions)
          inFlightActions.delete(key)
          return { inFlightActions }
        })
        return
      }

      await runTask(
        async () => {
          const state = get()
          const modelSelection = resolveEffectiveModel({
            sessionCurrent: state.modelSelections[selection.sessionId],
            userPreference: state.userPreference,
            defaultProvider: state.defaultProvider,
            defaultModel: state.defaultModel,
          })
          const admittedModelSelection = normalizeKimiModelSelection(
            modelSelection,
            state.providers,
          )
          const pendingAdmission = await reserveAdmission(window.localStorage, {
            apiBase: get().apiBase,
            sessionId: selection.sessionId,
            text,
            ...(attachments.length === 0 ? {} : { attachments }),
          })
          if (!isCurrentSelection(selection)) return
          const response = await requestJson<ApiAdmitInputResponse>(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/inputs`,
            {
              method: "POST",
              body: {
                requestId: pendingAdmission.requestId,
                content: {
                  kind: "text",
                  text,
                  ...(attachments.length === 0 ? {} : { attachments }),
                },
                ...(admittedModelSelection === undefined
                  ? {}
                  : { modelSelection: admittedModelSelection }),
              },
            },
          )
          if (
            response.requestId !== pendingAdmission.requestId ||
            response.event.sessionId !== selection.sessionId
          ) {
            throw new Error("Admission response did not match the request.")
          }
          await acknowledgeAdmission(window.localStorage, pendingAdmission)
          if (!isCurrentSelection(selection)) return
          if (
            (get().promptDraft ?? "").trim() === text &&
            sameAttachments(get().promptAttachments, attachments)
          ) {
            set({ promptDraft: undefined, promptAttachments: [] })
          }
          set((state) => {
            const inFlightActions = new Set(state.inFlightActions)
            inFlightActions.delete(key)
            return { inFlightActions }
          })
          if (!isCurrentSelection(selection)) return
          await get().loadSessions()
        },
        () => isCurrentSelection(selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    cancelTurn: async (turnId) => {
      const selection = currentSelection()
      if (!selection) return
      const key = `cancel:${turnId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          await requestJson(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
            { method: "POST", body: { reason: "user_cancel" } },
          )
        },
        () => isCurrentSelection(selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    cancelQueuedInput: async (inputId) => {
      const selection = currentSelection()
      if (!selection) return
      const key = `cancel-input:${inputId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          try {
            await cancelSessionInput(
              get().apiBase,
              selection.sessionId,
              inputId,
            )
          } catch (error) {
            if (!(error instanceof ApiRequestError && error.status === 409)) {
              throw error
            }
          }
        },
        () => isCurrentSelection(selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    resolvePermission: async (turnId, permissionRequestId, behavior) => {
      const selection = currentSelection()
      if (!selection) return
      const key = `permission:${permissionRequestId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
        execution: reduceExecutionView(state.execution, {
          type: "permission_resolving",
          permissionRequestId,
          behavior,
        }),
      }))
      const completed = await runTask(
        async () => {
          await requestJson(
            get().apiBase,
            `/sessions/${encodeURIComponent(selection.sessionId)}/turns/${encodeURIComponent(turnId)}/permissions/${encodeURIComponent(permissionRequestId)}/resolve`,
            {
              method: "POST",
              body: {
                behavior,
                reason: {
                  kind: behavior === "allow" ? "user_allowed" : "user_denied",
                },
              },
            },
          )
        },
        () => isCurrentSelection(selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return {
          inFlightActions,
          ...(!completed &&
          state.sessionSelectionIntentRevision === selection.revision &&
          state.selection.sessionId === selection.sessionId
            ? {
                execution: reduceExecutionView(state.execution, {
                  type: "permission_retry",
                  permissionRequestId,
                  behavior,
                }),
              }
            : {}),
        }
      })
    },

    setPromptDraft: (text) => {
      set({ promptDraft: text })
    },

    setPromptAttachments: (attachments) => {
      set({ promptAttachments: [...attachments] })
    },

    setModelSelection: (sessionId, selection) => {
      const apiBase = get().apiBase
      const modelSelections = { ...get().modelSelections }
      if (selection === undefined) delete modelSelections[sessionId]
      else modelSelections[sessionId] = selection
      set({
        modelSelections,
        ...(get().restoringModelSelectionFor === sessionId
          ? { restoringModelSelectionFor: undefined }
          : {}),
      })
      persistModelSelections(modelSelections)
      if (selection === undefined) return
      void runTask(
        async () => {
          const response =
            await requestJson<ApiUpdateUserModelPreferenceResponse>(
              apiBase,
              "/user-preference",
              { method: "PUT", body: selection },
            )
          if (apiBase !== get().apiBase) return
          if (!sameModelSelection(get().modelSelections[sessionId], selection))
            return
          set({ userPreference: response.userPreference })
        },
        () =>
          apiBase === get().apiBase &&
          sameModelSelection(get().modelSelections[sessionId], selection),
      )
    },
  }
})

export function resolveEffectiveModel(input: {
  readonly sessionCurrent: ModelSelection | undefined
  readonly userPreference: ApiUserModelPreference | undefined
  readonly defaultProvider: string | undefined
  readonly defaultModel: string | undefined
}): ModelSelection | undefined {
  if (input.sessionCurrent !== undefined) return input.sessionCurrent
  if (input.userPreference !== undefined) return input.userPreference
  if (input.defaultProvider === undefined || input.defaultModel === undefined) {
    return undefined
  }
  return { provider: input.defaultProvider, model: input.defaultModel }
}

export function normalizeKimiModelSelection(
  selection: ModelSelection | undefined,
  providers: readonly ApiProviderSummary[],
): ModelSelection | undefined {
  const effortStyle = providers
    .find((provider) => provider.name === selection?.provider)
    ?.models.find((model) => model.id === selection?.model)?.effortStyle
  if (
    selection?.provider !== "kimi" ||
    effortStyle !== "none" ||
    (selection.effort !== "on" && selection.effort !== "off")
  ) {
    return selection
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.speed === undefined ? {} : { speed: selection.speed }),
  }
}

export function useExecutionView(): ExecutionView {
  const execution = useAppStore((state) => state.execution)
  return useMemo(() => projectExecutionView(execution), [execution])
}

function applyDurableSessionDetail(
  session: ApiSessionDetail | undefined,
  event: StoredEventEnvelope,
): ApiSessionDetail | undefined {
  if (
    session === undefined ||
    event.sessionId !== session.id ||
    event.seq <= session.seq ||
    !isKernelEvent(event)
  ) {
    return session
  }

  const counts = { ...session.counts }
  let pendingInputs = [...session.pendingInputs]
  const next: ApiSessionDetail = {
    ...session,
    seq: event.seq,
    updatedAt: event.createdAt,
  }
  switch (event.type) {
    case "input.admitted":
      pendingInputs.push({
        id: event.data.inputId,
        text: event.data.content.text,
        admittedAt: event.createdAt,
      })
      return {
        ...next,
        pendingInputs,
        counts: {
          ...counts,
          inputs: counts.inputs + 1,
          pendingInputs: pendingInputs.length,
        },
      }
    case "input.cancelled":
      pendingInputs = pendingInputs.filter(
        (input) => input.id !== event.data.inputId,
      )
      return {
        ...next,
        pendingInputs,
        counts: { ...counts, pendingInputs: pendingInputs.length },
      }
    case "turn.started":
      pendingInputs = pendingInputs.filter(
        (input) => input.id !== event.data.inputId,
      )
      return {
        ...next,
        activeTurnId: event.data.turnId,
        pendingInputs,
        counts: {
          ...counts,
          pendingInputs: pendingInputs.length,
          turns: counts.turns + 1,
        },
      }
    case "turn.completed": {
      const { activeTurnId: _, ...withoutActiveTurn } = next
      return {
        ...withoutActiveTurn,
        ...(event.data.sessionUsage === undefined
          ? {}
          : { usage: event.data.sessionUsage }),
      }
    }
    case "item.completed":
      return {
        ...next,
        counts: {
          ...counts,
          items: counts.items + 1,
          tools:
            counts.tools +
            (event.data.item.type === "agent_message" ||
            event.data.item.type === "reasoning" ||
            event.data.item.type === "context_compaction"
              ? 0
              : 1),
        },
      }
    default:
      return next
  }
}

function applyTransientSessionDetail(
  session: ApiSessionDetail | undefined,
  event: LiveSessionEvent,
): ApiSessionDetail | undefined {
  if (session === undefined || event.sessionId !== session.id) return session
  if (event.type === "session.usage") return { ...session, usage: event.usage }
  if (event.type === "permission.requested") {
    if (
      session.pendingPermissions.some(
        (permission) =>
          permission.permissionRequestId === event.permissionRequestId,
      )
    ) {
      return session
    }
    const { type: _, sessionId: __, ...permission } = event
    const pendingPermissions: ApiPendingPermission[] = [
      ...session.pendingPermissions,
      permission,
    ]
    return {
      ...session,
      pendingPermissions,
      counts: {
        ...session.counts,
        permissions: pendingPermissions.length,
      },
    }
  }
  if (event.type === "permission.resolved") {
    const pendingPermissions = session.pendingPermissions.filter(
      (permission) =>
        permission.permissionRequestId !== event.permissionRequestId,
    )
    if (pendingPermissions.length === session.pendingPermissions.length) {
      return session
    }
    return {
      ...session,
      pendingPermissions,
      counts: {
        ...session.counts,
        permissions: pendingPermissions.length,
      },
    }
  }
  return session
}

function updateSessionSummary(
  sessions: readonly ApiSessionSummary[],
  selectedSession: ApiSessionDetail | undefined,
): ApiSessionSummary[] {
  if (selectedSession === undefined) return [...sessions]
  return sessions.map((session) =>
    session.id === selectedSession.id
      ? {
          ...session,
          seq: selectedSession.seq,
          updatedAt: selectedSession.updatedAt,
        }
      : session,
  )
}

function initialApiBase(): string {
  const queryApi = new URLSearchParams(window.location.search).get("api")
  if (queryApi) return queryApi
  return window.location.origin
}

function sameAttachments(
  left: readonly ImageAttachment[],
  right: readonly ImageAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (attachment, index) =>
        attachment.name === right[index]?.name &&
        attachment.mediaType === right[index]?.mediaType &&
        attachment.sizeBytes === right[index]?.sizeBytes &&
        attachment.detail === right[index]?.detail &&
        attachment.file.rolloutId === right[index]?.file.rolloutId &&
        attachment.file.path === right[index]?.file.path,
    )
  )
}

function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.effort === right?.effort &&
    left?.speed === right?.speed
  )
}

function initialModelSelections(): Record<string, ModelSelection> {
  // Read via window: Node 24 exposes a bare global localStorage stub whose
  // methods throw, and test environments leave it in place.
  const raw = window.localStorage.getItem("yakitori.modelSelections")
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as Record<string, ModelSelection>
  } catch {
    return {}
  }
}

function persistModelSelections(
  modelSelections: Readonly<Record<string, ModelSelection>>,
): void {
  window.localStorage.setItem(
    "yakitori.modelSelections",
    JSON.stringify(modelSelections),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}
