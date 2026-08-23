import { useMemo } from "react"
import { create } from "zustand"
import {
  COMPACT_DIRECTIVE,
  EventType,
  type InlineImageAttachment,
  type ModelSelection,
  type StoredEventEnvelope,
} from "../../kernel/events.ts"
import { createRequestId } from "../../kernel/ids.ts"
import type {
  ApiAdmitInputResponse,
  ApiCompactSessionResponse,
  ApiCreateSessionResponse,
  ApiForkSessionResponse,
  ApiListProjectsResponse,
  ApiListProvidersResponse,
  ApiListSessionsResponse,
  ApiProviderSummary,
  ApiReadSessionResponse,
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
import {
  beginSessionSelection,
  clearSessionSelection,
  createSessionSelectionState,
  currentSessionSelection,
  isCurrentSessionSelection,
  type SessionSelection,
  type SessionSelectionState,
} from "../session-selection.ts"

export type StreamStatus = "connected" | "connecting" | "disconnected" | "idle"

export type AppStoreData = {
  apiBase: string
  busy: boolean
  composerFocusRevision: number
  defaultModel: string | undefined
  defaultProvider: string | undefined
  execution: ExecutionViewState
  inFlightActions: ReadonlySet<string>
  message: string | undefined
  modelSelectionReady: boolean
  modelSelections: Record<string, ModelSelection>
  nextCursor: string | undefined
  promptDraft: string | undefined
  promptAttachments: readonly InlineImageAttachment[]
  projects: string[]
  providers: ApiProviderSummary[]
  userPreference: ApiUserModelPreference | undefined
  selection: SessionSelectionState
  sessionDetailRevision: number
  sessionListRevision: number
  sessionSelectionIntentRevision: number
  selectedSession: ApiSessionDetail | undefined
  sessions: ApiSessionSummary[]
  stream: EventSource | undefined
  streamStatus: StreamStatus
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
    attachments?: readonly InlineImageAttachment[],
  ): Promise<void>
  cancelTurn(turnId: string): Promise<void>
  cancelQueuedInput(inputId: string): Promise<void>
  resolvePermission(
    turnId: string,
    permissionRequestId: string,
    behavior: "allow" | "deny",
  ): Promise<void>
  setPromptDraft(text: string): void
  setPromptAttachments(attachments: readonly InlineImageAttachment[]): void
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
    modelSelectionReady: true,
    modelSelections: initialModelSelections(),
    nextCursor: undefined,
    promptDraft: undefined,
    promptAttachments: [],
    projects: [],
    providers: [],
    userPreference: undefined,
    selection: createSessionSelectionState(),
    sessionDetailRevision: 0,
    sessionListRevision: 0,
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessions: [],
    stream: undefined,
    streamStatus: "idle",
    currentProject: undefined,
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  const restoringModelSelections = new Set<string>()
  let userPreferenceRevision = 0
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

  const syncSelection = (): void => {
    set({ selection: { ...get().selection } })
  }

  const activateSession = (sessionId: string): SessionSelection => {
    set((state) => ({
      sessionDetailRevision: state.sessionDetailRevision + 1,
    }))
    const selection = beginSessionSelection(get().selection, sessionId)
    syncSelection()
    return selection
  }

  const closeStream = (): void => {
    get().stream?.close()
    set({ stream: undefined, streamStatus: "idle" })
  }

  const mergeEvent = (event: StoredEventEnvelope): void => {
    const state = get()
    if (
      state.execution.durableEvents.some(
        (candidate) => candidate.id === event.id,
      )
    ) {
      return
    }
    set({
      execution: reduceExecutionView(state.execution, {
        type: "durable",
        event,
      }),
    })
  }

  const refreshSelectedSession = async (
    selection: SessionSelection,
  ): Promise<boolean> => {
    const requestRevision = get().sessionDetailRevision + 1
    set({ sessionDetailRevision: requestRevision })
    let response: ApiReadSessionResponse
    try {
      response = await requestJson<ApiReadSessionResponse>(
        get().apiBase,
        `/sessions/${encodeURIComponent(selection.sessionId)}`,
      )
    } catch (error) {
      if (
        !isCurrentSessionSelection(get().selection, selection) ||
        get().sessionDetailRevision !== requestRevision
      ) {
        return false
      }
      throw error
    }
    if (
      !isCurrentSessionSelection(get().selection, selection) ||
      get().sessionDetailRevision !== requestRevision
    ) {
      return false
    }
    if (
      restoringModelSelections.has(selection.sessionId) &&
      response.session.currentModel !== undefined
    ) {
      restoringModelSelections.delete(selection.sessionId)
      const modelSelections = {
        ...get().modelSelections,
        [selection.sessionId]: response.session.currentModel,
      }
      persistModelSelections(modelSelections)
      set({
        selectedSession: response.session,
        modelSelections,
        modelSelectionReady: true,
      })
    } else {
      set({ selectedSession: response.session })
    }
    return true
  }

  const connectEvents = (selection: SessionSelection, after: number): void => {
    if (!isCurrentSessionSelection(get().selection, selection)) return
    closeStream()

    try {
      set({ streamStatus: "connecting" })
      const source = openSessionEventStream(
        get().apiBase,
        selection.sessionId,
        after,
        {
          onOpen: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            set({ streamStatus: "connected" })
          },
          onReplayComplete: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            restoringModelSelections.delete(selection.sessionId)
            set({ modelSelectionReady: true })
          },
          onEvent: (event) => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            mergeEvent(event)
            void refreshSelectedSession(selection).then(
              () => {},
              (error: unknown) => {
                if (!isCurrentSessionSelection(get().selection, selection)) {
                  return
                }
                set({
                  message: errorMessage(error, "Could not refresh session."),
                })
              },
            )
          },
          onTransient: (event) => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            set({
              execution: reduceExecutionView(get().execution, {
                type: "transient",
                event,
              }),
            })
          },
          onError: () => {
            if (
              get().stream !== source ||
              !isCurrentSessionSelection(get().selection, selection)
            ) {
              return
            }
            set({ streamStatus: "disconnected" })
          },
        },
      )
      set({ stream: source })
    } catch (error) {
      closeStream()
      if (!isCurrentSessionSelection(get().selection, selection)) return
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
      clearSessionSelection(get().selection)
      set((state) => ({
        selection: { ...state.selection },
        sessionDetailRevision: state.sessionDetailRevision + 1,
        selectedSession: undefined,
        execution: createExecutionViewState(),
      }))
    },

    loadSessions: async (input = {}) => {
      const requestRevision = get().sessionListRevision + 1
      set({ sessionListRevision: requestRevision })
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
          if (get().sessionListRevision !== requestRevision) {
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
        () => get().sessionListRevision === requestRevision,
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
      const sourceSelection = currentSessionSelection(get().selection)
      if (!sourceSelection) return
      const key = `fork:${sourceSelection.sessionId}:${atInputId}`
      if (get().inFlightActions.has(key)) return
      const intentRevision = get().sessionSelectionIntentRevision + 1
      const state = get()
      const sourceEvents = [...state.execution.durableEvents]
      const sourceModelSelection = normalizeKimiModelSelection(
        resolveEffectiveModel({
          sessionCurrent: state.modelSelections[sourceSelection.sessionId],
          userPreference: state.userPreference,
          defaultProvider: state.defaultProvider,
          defaultModel: state.defaultModel,
        }),
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
            !isCurrentSessionSelection(get().selection, sourceSelection)
          ) {
            return
          }
          if (sourceModelSelection !== undefined) {
            get().setModelSelection(response.session.id, sourceModelSelection)
          }

          const cutIndex = sourceEvents.findIndex(
            (event) =>
              event.type === EventType.InputAdmitted &&
              event.data.inputId === atInputId,
          )
          const created = response.events[0]
          if (
            cutIndex < 0 ||
            created?.type !== EventType.SessionCreated ||
            sourceEvents[cutIndex]?.seq !== response.historyEndSeqExclusive
          ) {
            throw new Error(
              "Fork response could not be joined to source history.",
            )
          }
          const events = [
            created,
            ...sourceEvents.slice(1, cutIndex).map((event) => ({
              ...event,
              sessionId: response.session.id,
            })),
            ...response.events.slice(1),
          ]
          const selection = activateSession(response.session.id)
          closeStream()
          set((state) => ({
            selectedSession: response.session,
            execution: events.reduce(
              (execution, event) =>
                reduceExecutionView(execution, {
                  type: "durable",
                  event,
                }),
              createExecutionViewState(),
            ),
            promptDraft: undefined,
            promptAttachments: [],
            composerFocusRevision: state.composerFocusRevision + 1,
          }))
          connectEvents(selection, events.at(-1)?.seq ?? response.session.seq)
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
          clearSessionSelection(get().selection)
          set((state) => ({
            selection: { ...state.selection },
            sessionDetailRevision: state.sessionDetailRevision + 1,
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
      clearSessionSelection(get().selection)
      set((state) => ({
        selection: { ...state.selection },
        sessionDetailRevision: state.sessionDetailRevision + 1,
        sessionListRevision: state.sessionListRevision + 1,
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
      if (get().modelSelections[sessionId] === undefined) {
        restoringModelSelections.add(sessionId)
        set({ modelSelectionReady: false })
      } else {
        restoringModelSelections.delete(sessionId)
        set({ modelSelectionReady: true })
      }
      const selection = activateSession(sessionId)
      closeStream()
      set({
        execution: createExecutionViewState(),
        promptDraft: undefined,
        promptAttachments: [],
        selectedSession: undefined,
      })
      await runTask(
        async () => {
          const applied = await refreshSelectedSession(selection)
          if (!applied) return
          connectEvents(selection, 0)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
    },

    admitInput: async (text, attachments = []) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection || !get().modelSelectionReady) return
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
            if (!isCurrentSessionSelection(get().selection, selection)) return
            if (
              get().promptDraft?.trim() === text &&
              sameAttachments(get().promptAttachments, attachments)
            ) {
              set({ promptDraft: undefined, promptAttachments: [] })
            }
            mergeEvent(response.event)
            await refreshSelectedSession(selection)
          },
          () => isCurrentSessionSelection(get().selection, selection),
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
          const admittedModelSelection =
            normalizeKimiModelSelection(modelSelection)
          const pendingAdmission = await reserveAdmission(window.localStorage, {
            apiBase: get().apiBase,
            sessionId: selection.sessionId,
            text,
            ...(attachments.length === 0 ? {} : { attachments }),
          })
          if (!isCurrentSessionSelection(get().selection, selection)) return
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
          if (!isCurrentSessionSelection(get().selection, selection)) return
          if (
            get().promptDraft?.trim() === text &&
            sameAttachments(get().promptAttachments, attachments)
          ) {
            set({ promptDraft: undefined, promptAttachments: [] })
          }
          mergeEvent(response.event)
          set((state) => {
            const inFlightActions = new Set(state.inFlightActions)
            inFlightActions.delete(key)
            return { inFlightActions }
          })
          await refreshSelectedSession(selection)
          if (!isCurrentSessionSelection(get().selection, selection)) return
          await get().loadSessions()
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    cancelTurn: async (turnId) => {
      const selection = currentSessionSelection(get().selection)
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
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    cancelQueuedInput: async (inputId) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return
      const key = `cancel-input:${inputId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
        async () => {
          try {
            const response = await cancelSessionInput(
              get().apiBase,
              selection.sessionId,
              inputId,
            )
            if (!isCurrentSessionSelection(get().selection, selection)) return
            // Merge the recorded fact now; the SSE replay dedups by event id.
            mergeEvent(response.event)
          } catch (error) {
            // 409 means the input already left the pending queue (usually it
            // just started); the detail refresh below reconciles the view.
            if (!(error instanceof ApiRequestError && error.status === 409)) {
              throw error
            }
          }
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    resolvePermission: async (turnId, permissionRequestId, behavior) => {
      const selection = currentSessionSelection(get().selection)
      if (!selection) return
      const key = `permission:${permissionRequestId}`
      if (get().inFlightActions.has(key)) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      await runTask(
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
          await refreshSelectedSession(selection)
        },
        () => isCurrentSessionSelection(get().selection, selection),
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    setPromptDraft: (text) => {
      set({ promptDraft: text })
    },

    setPromptAttachments: (attachments) => {
      set({ promptAttachments: [...attachments] })
    },

    setModelSelection: (sessionId, selection) => {
      userPreferenceRevision += 1
      const preferenceRevision = userPreferenceRevision
      const apiBase = get().apiBase
      restoringModelSelections.delete(sessionId)
      const modelSelections = { ...get().modelSelections }
      if (selection === undefined) delete modelSelections[sessionId]
      else modelSelections[sessionId] = selection
      set({ modelSelections, modelSelectionReady: true })
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
          if (
            preferenceRevision !== userPreferenceRevision ||
            apiBase !== get().apiBase
          ) {
            return
          }
          set({ userPreference: response.userPreference })
        },
        () =>
          preferenceRevision === userPreferenceRevision &&
          apiBase === get().apiBase,
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
): ModelSelection | undefined {
  if (
    selection?.provider !== "kimi" ||
    (selection.model !== "kimi-for-coding" &&
      selection.model !== "kimi-for-coding-highspeed") ||
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
  const selectedSession = useAppStore((state) => state.selectedSession)
  return useMemo(
    () => projectExecutionView(execution, selectedSession),
    [execution, selectedSession],
  )
}

function initialApiBase(): string {
  const queryApi = new URLSearchParams(window.location.search).get("api")
  if (queryApi) return queryApi
  return window.location.origin
}

function sameAttachments(
  left: readonly InlineImageAttachment[],
  right: readonly InlineImageAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (attachment, index) =>
        attachment.name === right[index]?.name &&
        attachment.mediaType === right[index]?.mediaType &&
        attachment.sizeBytes === right[index]?.sizeBytes &&
        attachment.data === right[index]?.data,
    )
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
