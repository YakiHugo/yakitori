import type {
  SessionSidebar,
  SidebarChange,
} from "../../core/session-sidebar.ts"
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
  ApiPendingPermission,
  ApiProject,
  ApiProviderSummary,
  ApiSessionDetail,
  ApiSessionSummary,
  ApiSkillSummary,
  ApiSubscriptionProvider,
  ApiSubscriptionSummary,
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
  type AppRpcClient,
  getAppRpcClient,
  type SessionStream,
} from "../lib/rpc-client.ts"

type SessionSelection = {
  readonly revision: number
  readonly sessionId: string
}

export type SessionDraft = Readonly<{
  text: string | undefined
  attachments: readonly ImageAttachment[]
}>

// The sidebar loads each expanded Project's sessions independently; the empty
// key holds the All sessions view, including sessions without a live project.
export const allSessionsListKey = ""

export type SidebarListFilter = Readonly<{
  sectionId?: string
  archived?: boolean
}>
export function sessionListKey(
  projectId: string | undefined,
  filter: SidebarListFilter = {},
): string {
  return filter.archived
    ? "sidebar:archived"
    : filter.sectionId === undefined
      ? (projectId ?? allSessionsListKey)
      : `sidebar:section:${filter.sectionId}`
}

export type ProjectSessionList = Readonly<{
  sessions: ApiSessionSummary[]
  nextCursor?: string
  loading?: boolean
  error?: string
}>

export type SubscriptionUsageState = Readonly<{
  subscription?: ApiSubscriptionSummary
  loading: boolean
  error?: string
  updatedAt?: number
}>

export type AppStoreData = {
  sidebar: SessionSidebar
  collapsedSections: Record<string, boolean>
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
  // The active session's live composer state. Drafts of inactive sessions
  // park in sessionDrafts and are restored on selection; neither is a
  // persistence or attachment-lifecycle authority.
  draftModelSelection: ModelSelection | undefined
  newSessionPrompt: string | undefined
  promptDraft: string | undefined
  promptAttachments: readonly ImageAttachment[]
  sessionDrafts: Record<string, SessionDraft>
  // Skills discoverable in the selected session's working directory.
  sessionSkills: readonly ApiSkillSummary[]
  sessionSkillsError: string | undefined
  hydratingSessionId: string | undefined
  projects: ApiProject[]
  // Last project-list load failure; the sidebar keeps the last good list and
  // shows a retry note while this is set.
  projectsError: string | undefined
  providers: ApiProviderSummary[]
  subscriptionsByProvider: Record<
    ApiSubscriptionProvider,
    SubscriptionUsageState
  >
  userPreference: ApiUserModelPreference | undefined
  selection: { readonly sessionId?: string }
  sessionSelectionIntentRevision: number
  selectedSession: ApiSessionDetail | undefined
  sessionsByProject: Record<string, ProjectSessionList>
  stream: SessionStream | undefined
  // The Project new sessions are created in (entity-based since the C8-D2
  // cutover); follows the last clicked project or selected session.
  currentProject: string | undefined
  // Project ids the user collapsed in the sidebar; projects expand by
  // default, so only collapsed ids are recorded (persisted locally).
  collapsedProjects: Record<string, boolean>
}

export type AppStoreActions = {
  boot(): Promise<void>
  loadSessions(
    projectId: string | undefined,
    input?: Readonly<{ append?: boolean }> & SidebarListFilter,
  ): Promise<boolean>
  setSectionOpen(sectionId: string, open: boolean): void
  loadSidebar(): Promise<void>
  refreshSidebar(): Promise<void>
  changeSidebar(change: SidebarChange): Promise<boolean>
  loadProjects(): Promise<void>
  loadProviders(): Promise<void>
  loadSubscriptions(): Promise<void>
  startNewSession(projectId?: string): void
  createSession(title?: string): Promise<string | undefined>
  deleteSession(sessionId: string): Promise<void>
  forkSession(
    atInputId: string,
    reason: "undo" | "edit",
    content?: string,
  ): Promise<void>
  toggleProject(projectId: string): Promise<void>
  addProject(path: string, name?: string): Promise<boolean>
  updateProject(
    projectId: string,
    input: { readonly name?: string; readonly roots?: readonly string[] },
  ): Promise<boolean>
  removeProject(projectId: string): Promise<boolean>
  toggleProjectPinned(projectId: string): Promise<boolean>
  moveProject(
    projectId: string,
    targetId: string,
    after: boolean,
  ): Promise<boolean>
  selectSession(sessionId: string, summary?: ApiSessionSummary): Promise<void>
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
    sessionId: string | undefined,
    selection: ModelSelection | undefined,
  ): void
}

export type AppStore = AppStoreData & AppStoreActions

function createInitialSubscriptionUsage(): Record<
  ApiSubscriptionProvider,
  SubscriptionUsageState
> {
  return {
    codex: { loading: false },
    grok: { loading: false },
    kimi: { loading: false },
  }
}

function subscriptionUsageLoading(
  state: SubscriptionUsageState,
): SubscriptionUsageState {
  return {
    ...(state.subscription === undefined
      ? {}
      : { subscription: state.subscription }),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    loading: true,
  }
}

export function createInitialAppState(): AppStoreData {
  return {
    sidebar: { sections: [], entries: {} },
    collapsedSections: JSON.parse(
      window.localStorage.getItem("yakitori.collapsedSections") ?? "{}",
    ) as Record<string, boolean>,
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
    draftModelSelection: undefined,
    newSessionPrompt: undefined,
    promptDraft: undefined,
    promptAttachments: [],
    sessionDrafts: {},
    sessionSkills: [],
    sessionSkillsError: undefined,
    hydratingSessionId: undefined,
    projects: [],
    projectsError: undefined,
    providers: [],
    subscriptionsByProvider: createInitialSubscriptionUsage(),
    userPreference: undefined,
    selection: {},
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessionsByProject: {},
    stream: undefined,
    currentProject: undefined,
    collapsedProjects: initialCollapsedProjects(),
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  const sessionListRevisions: Record<string, number> = {}
  let sidebarReadRevision = 0
  // Sidebar mutations are serialized through this chain so rapid pin/move
  // clicks each reach the server in click order instead of being dropped
  // while an earlier change is in flight. runTask never rejects, so a failed
  // change cannot wedge the queue.
  let sidebarQueue: Promise<unknown> = Promise.resolve()
  const subscriptionReadRevisions: Record<ApiSubscriptionProvider, number> = {
    codex: 0,
    grok: 0,
    kimi: 0,
  }
  let projectChangesSubscribedClient: AppRpcClient | undefined
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

  const loadSessionSkills = (sessionId: string): void => {
    const revision = get().sessionSelectionIntentRevision
    set({ sessionSkillsError: undefined })
    void getAppRpcClient(get().apiBase)
      .request("session/skills", { sessionId })
      .then((response) => {
        if (
          get().selection.sessionId !== sessionId ||
          get().sessionSelectionIntentRevision !== revision
        ) {
          return
        }
        set({ sessionSkills: response.skills })
      })
      .catch((error: unknown) => {
        if (
          get().selection.sessionId !== sessionId ||
          get().sessionSelectionIntentRevision !== revision
        )
          return
        set({
          sessionSkillsError: errorMessage(error, "Could not load skills."),
        })
      })
  }

  const connectEvents = (selection: SessionSelection, after: number): void => {
    if (!isCurrentSelection(selection)) return
    closeStream()
    if (after === 0) set({ hydratingSessionId: selection.sessionId })

    let replaySnapshot: ApiSessionDetail | undefined
    try {
      const source = getAppRpcClient(get().apiBase).openSessionStream(
        selection.sessionId,
        after,
        {
          onSnapshot: (response) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            replaySnapshot = response.session
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
              currentProject: response.session.projectId,
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
            const snapshot = replaySnapshot
            replaySnapshot = undefined
            set((state) => ({
              hydratingSessionId: undefined,
              execution:
                snapshot === undefined
                  ? state.execution
                  : reduceExecutionView(state.execution, {
                      type: "replay_completed",
                      session: snapshot,
                    }),
            }))
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
                sessionsByProject: updateSessionSummaryInLists(
                  state.sessionsByProject,
                  selectedSession,
                ),
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
              ...((event.type === "runtime.warning" &&
                event.code !== "model.retry") ||
              (event.type === "session.error" &&
                event.operation !== "turn_input")
                ? { message: event.message }
                : {}),
            }))
          },
          onError: (error) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            set({
              stream: undefined,
              hydratingSessionId: undefined,
              execution: reduceExecutionView(get().execution, {
                type: "stream_unavailable",
              }),
              message: errorMessage(error, "Could not open event stream."),
            })
          },
        },
      )
      set({ stream: source })
    } catch (error) {
      closeStream()
      if (!isCurrentSelection(selection)) return
      set({
        hydratingSessionId: undefined,
        message: errorMessage(error, "Could not open event stream."),
      })
    }
  }

  return {
    ...createInitialAppState(),

    boot: async () => {
      const intentRevision = get().sessionSelectionIntentRevision
      const client = getAppRpcClient(get().apiBase)
      if (projectChangesSubscribedClient !== client) {
        projectChangesSubscribedClient = client
        client.subscribeToSidebarChanges(() => {
          void get().refreshSidebar()
        })
        client.subscribeToProjectChanges(() => {
          void get().loadProjects()
        })
        client.subscribeToSessionActivity((activeSessionIds) => {
          if (activeSessionIds === undefined) {
            void get().refreshSidebar()
            return
          }
          const active = new Set(activeSessionIds)
          set((state) => {
            let changed = false
            const sessionsByProject = Object.fromEntries(
              Object.entries(state.sessionsByProject).map(([key, list]) => {
                let listChanged = false
                const sessions = list.sessions.map((session) => {
                  const nextActive = active.has(session.id)
                  if ((session.active ?? false) === nextActive) return session
                  listChanged = true
                  return { ...session, active: nextActive }
                })
                if (!listChanged) return [key, list]
                changed = true
                return [key, { ...list, sessions }]
              }),
            )
            return changed ? { sessionsByProject } : {}
          })
        })
      }
      await get().loadSidebar()
      await get().loadProviders()
      await get().loadProjects()
      const currentProject = get().currentProject
      const loaded = await get().loadSessions(currentProject)
      if (!loaded || get().sessionSelectionIntentRevision !== intentRevision) {
        return
      }
      const session =
        get().sessionsByProject[sessionListKey(currentProject)]?.sessions.at(0)
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

    loadSessions: async (projectId, input = {}) => {
      const key = sessionListKey(projectId, input)
      const requestRevision = (sessionListRevisions[key] ?? 0) + 1
      sessionListRevisions[key] = requestRevision
      const cursor = input.append
        ? get().sessionsByProject[key]?.nextCursor
        : undefined
      set((state) => ({
        sessionsByProject: {
          ...state.sessionsByProject,
          [key]: {
            ...state.sessionsByProject[key],
            sessions: state.sessionsByProject[key]?.sessions ?? [],
            loading: true,
          },
        },
      }))
      let applied = false
      const completed = await runTask(
        async () => {
          const response = await getAppRpcClient(get().apiBase).request(
            "session/list",
            {
              limit: 30,
              ...(input.archived ? { archived: true } : {}),
              ...(input.sectionId === undefined
                ? projectId === undefined
                  ? {}
                  : { sectionId: null }
                : { sectionId: input.sectionId }),
              ...(cursor === undefined ? {} : { cursor }),
              ...(projectId === undefined ? {} : { projectId }),
            },
          )
          if (sessionListRevisions[key] !== requestRevision) return
          set((state) => {
            const current = state.sessionsByProject[key]
            return {
              sessionsByProject: {
                ...state.sessionsByProject,
                [key]: {
                  sessions: input.append
                    ? [
                        ...new Map(
                          [
                            ...(current?.sessions ?? []),
                            ...response.sessions,
                          ].map((session) => [
                            session.navigationId ?? session.id,
                            session,
                          ]),
                        ).values(),
                      ]
                    : [...response.sessions],
                  ...(response.nextCursor === undefined
                    ? {}
                    : { nextCursor: response.nextCursor }),
                },
              },
            }
          })
          applied = true
        },
        () => sessionListRevisions[key] === requestRevision,
      )
      if (!completed && sessionListRevisions[key] === requestRevision) {
        set((state) => ({
          sessionsByProject: {
            ...state.sessionsByProject,
            [key]: {
              ...state.sessionsByProject[key],
              sessions: state.sessionsByProject[key]?.sessions ?? [],
              loading: false,
              error: "Could not load sessions.",
            },
          },
        }))
      }
      return completed && applied
    },

    setSectionOpen: (sectionId, open) => {
      const collapsedSections = { ...get().collapsedSections }
      if (open) delete collapsedSections[sectionId]
      else collapsedSections[sectionId] = true
      set({ collapsedSections })
      window.localStorage.setItem(
        "yakitori.collapsedSections",
        JSON.stringify(collapsedSections),
      )
    },
    loadSidebar: async () => {
      const revision = ++sidebarReadRevision
      await runTask(async () => {
        const sidebar = await getAppRpcClient(get().apiBase).request(
          "sidebar/read",
          {},
        )
        if (revision !== sidebarReadRevision) return
        set((state) => {
          if (!state.selectedSession) return { sidebar }
          const {
            archived: _,
            sectionId: __,
            sectionPosition: ___,
            ...session
          } = state.selectedSession
          return {
            sidebar,
            selectedSession: {
              ...session,
              ...sidebar.entries[session.navigationId ?? session.id],
            },
          }
        })
      })
    },
    refreshSidebar: async () => {
      await get().loadSidebar()
      await Promise.all(
        [
          ...new Set([
            sessionListKey(get().currentProject),
            ...Object.keys(get().sessionsByProject),
          ]),
        ].map((key) =>
          key === "sidebar:archived"
            ? get().loadSessions(undefined, { archived: true })
            : key.startsWith("sidebar:section:")
              ? get().loadSessions(undefined, {
                  sectionId: key.slice("sidebar:section:".length),
                })
              : get().loadSessions(
                  key === allSessionsListKey ? undefined : key,
                ),
        ),
      )
    },
    changeSidebar: (change) => {
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add("sidebar-update"),
      }))
      const run = sidebarQueue.then(() =>
        runTask(async () => {
          const sidebar = await getAppRpcClient(get().apiBase).request(
            "sidebar/update",
            change,
          )
          sidebarReadRevision += 1
          set({ sidebar })
          if (
            (change.type === "session" || change.type === "move-session") &&
            change.sectionId
          )
            get().setSectionOpen(change.sectionId, true)
          await get().refreshSidebar()
        }),
      )
      sidebarQueue = run
      // Clear the flag only once the queue has drained so controls gated on
      // it do not flicker enabled between queued changes.
      void run.then(() => {
        if (sidebarQueue !== run) return
        set((state) => {
          const inFlightActions = new Set(state.inFlightActions)
          inFlightActions.delete("sidebar-update")
          return { inFlightActions }
        })
      })
      return run
    },

    loadProjects: async () => {
      try {
        const response = await getAppRpcClient(get().apiBase).request(
          "project/list",
          {},
        )
        const projects = [...response.projects]
        set((state) => {
          const liveIds = new Set(projects.map((project) => project.id))
          const sessionsByProject = Object.fromEntries(
            Object.entries(state.sessionsByProject).filter(
              ([key]) =>
                key === allSessionsListKey ||
                key.startsWith("sidebar:") ||
                liveIds.has(key),
            ),
          )
          const collapsedProjects = Object.fromEntries(
            Object.entries(state.collapsedProjects).filter(([id]) =>
              liveIds.has(id),
            ),
          )
          persistCollapsedProjects(collapsedProjects)
          const remembered = window.localStorage.getItem("yakitori.project")
          const currentProject =
            state.currentProject !== undefined &&
            liveIds.has(state.currentProject)
              ? state.currentProject
              : remembered !== null && liveIds.has(remembered)
                ? remembered
                : projects[0]?.id
          return {
            projects,
            projectsError: undefined,
            currentProject,
            sessionsByProject,
            collapsedProjects,
          }
        })
      } catch (error) {
        // Servers without a project store answer not_found; the switcher
        // stays hidden there. Other failures keep the last good list and
        // surface a retry note instead of silently showing an empty sidebar.
        if (error instanceof ApiRequestError && error.code === "not_found")
          return
        set({ projectsError: "Could not load projects." })
      }
    },

    loadProviders: async () => {
      const apiBase = get().apiBase
      try {
        const response = await getAppRpcClient(apiBase).request(
          "provider/list",
          {},
        )
        set({
          providers: [...response.providers],
          defaultProvider: response.defaultProvider,
          defaultModel: response.defaultModel,
          userPreference: response.userPreference,
        })
      } catch {
        // Servers without a provider catalog answer method-not-found; the
        // model selector stays hidden.
      }
    },

    loadSubscriptions: async () => {
      const apiBase = get().apiBase
      const providers = ["codex", "grok", "kimi"] as const
      const revisions = Object.fromEntries(
        providers.map((provider) => [
          provider,
          ++subscriptionReadRevisions[provider],
        ]),
      ) as Record<ApiSubscriptionProvider, number>
      set((state) => ({
        subscriptionsByProvider: {
          codex: subscriptionUsageLoading(state.subscriptionsByProvider.codex),
          grok: subscriptionUsageLoading(state.subscriptionsByProvider.grok),
          kimi: subscriptionUsageLoading(state.subscriptionsByProvider.kimi),
        },
      }))
      await Promise.all(
        providers.map(async (provider) => {
          try {
            const response = await getAppRpcClient(apiBase).request(
              "subscription/read",
              { provider },
            )
            if (revisions[provider] !== subscriptionReadRevisions[provider])
              return
            set((state) => ({
              subscriptionsByProvider: {
                ...state.subscriptionsByProvider,
                [provider]: {
                  subscription: response.subscription,
                  loading: false,
                  updatedAt: response.fetchedAt,
                },
              },
            }))
          } catch {
            if (revisions[provider] !== subscriptionReadRevisions[provider])
              return
            set((state) => ({
              subscriptionsByProvider: {
                ...state.subscriptionsByProvider,
                [provider]: {
                  ...state.subscriptionsByProvider[provider],
                  loading: false,
                  error: "Could not update usage.",
                },
              },
            }))
          }
        }),
      )
    },

    startNewSession: (projectId = get().currentProject) => {
      const state = get()
      closeStream()
      set({
        sessionDrafts: stashSessionDraft(state),
        currentProject: projectId,
        selection: {},
        selectedSession: undefined,
        execution: createExecutionViewState(),
        hydratingSessionId: undefined,
        sessionSkills: [],
        promptAttachments: [],
        promptDraft:
          state.selection.sessionId === undefined
            ? state.promptDraft
            : state.newSessionPrompt,
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        composerFocusRevision: state.composerFocusRevision + 1,
      })
    },

    createSession: async (title) => {
      if (get().inFlightActions.has("create-session")) return
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add("create-session"),
      }))
      let createdId: string | undefined
      const intentRevision = get().sessionSelectionIntentRevision + 1
      set({ sessionSelectionIntentRevision: intentRevision })
      await runTask(
        async () => {
          const project = get().projects.find(
            (candidate) => candidate.id === get().currentProject,
          )
          const firstRoot = project?.roots[0]
          const response = await getAppRpcClient(get().apiBase).request(
            "session/create",
            {
              ...(title === undefined ? {} : { title }),
              ...(project === undefined ? {} : { projectId: project.id }),
              ...(firstRoot === undefined
                ? {}
                : { workingDirectory: firstRoot }),
            },
          )

          if (
            project !== undefined &&
            get().collapsedProjects[project.id] === true
          ) {
            const collapsedProjects = { ...get().collapsedProjects }
            delete collapsedProjects[project.id]
            set({ collapsedProjects })
            persistCollapsedProjects(collapsedProjects)
          }
          await get().loadSessions(project?.id)
          if (get().sessionSelectionIntentRevision !== intentRevision) return
          createdId = response.session.id
          const draftModel = get().draftModelSelection
          if (draftModel !== undefined) {
            const modelSelections = {
              ...get().modelSelections,
              [createdId]: draftModel,
            }
            set({ modelSelections })
            persistModelSelections(modelSelections)
          }
          set({ newSessionPrompt: undefined })
          const draftAtCreation =
            get().selection.sessionId === undefined
              ? get().promptDraft
              : undefined
          const parkedDrafts = stashSessionDraft(get())
          const selection = activateSession(response.session.id)
          set({
            selectedSession: response.session,
            execution: reduceExecutionView(createExecutionViewState(), {
              type: "durable",
              event: response.event,
            }),
            sessionSkills: [],
            ...takeSessionDraft(parkedDrafts, response.session.id),
            ...(draftAtCreation === undefined
              ? {}
              : { promptDraft: draftAtCreation }),
          })
          connectEvents(selection, response.event.seq)
          loadSessionSkills(response.session.id)
        },
        () => get().sessionSelectionIntentRevision === intentRevision,
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete("create-session")
        return { inFlightActions }
      })
      return createdId
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
          providers: state.providers,
        }),
        state.providers,
      )
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
        sessionSelectionIntentRevision: intentRevision,
      }))

      const completed = await runTask(
        async () => {
          const response = await getAppRpcClient(get().apiBase).request(
            "session/fork",
            {
              sessionId: sourceSelection.sessionId,
              atInputId,
              reason,
              ...(content === undefined
                ? {}
                : {
                    content: {
                      kind: "text" as const,
                      text: content,
                    },
                  }),
              ...(reason !== "edit" || sourceModelSelection === undefined
                ? {}
                : { modelSelection: sourceModelSelection }),
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

          const parkedDrafts = stashSessionDraft(get())
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
            ...takeSessionDraft(parkedDrafts, response.session.id),
            sessionSkills: [],
            composerFocusRevision: state.composerFocusRevision + 1,
          }))
          connectEvents(
            selection,
            response.events.at(-1)?.seq ?? response.session.seq,
          )
          loadSessionSkills(response.session.id)
          await get().refreshSidebar()
        },
        () => get().sessionSelectionIntentRevision === intentRevision,
      )

      // The fork intent invalidated the old stream. A failed edit keeps the
      // source conversation open and catches up events received in the meantime.
      if (!completed && isCurrentSelection(sourceSelection)) {
        connectEvents(sourceSelection, get().execution.lastSeq)
      }

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
        await getAppRpcClient(get().apiBase).request("session/delete", {
          sessionId,
        })
        if (get().selection.sessionId === sessionId) {
          closeStream()
          set((state) => {
            const sessionDrafts = { ...state.sessionDrafts }
            delete sessionDrafts[sessionId]
            return {
              selection: {},
              sessionSelectionIntentRevision:
                state.sessionSelectionIntentRevision + 1,
              selectedSession: undefined,
              execution: createExecutionViewState(),
              promptDraft: undefined,
              promptAttachments: [],
              sessionSkills: [],
              sessionDrafts,
            }
          })
        } else if (get().sessionDrafts[sessionId] !== undefined) {
          set((state) => {
            const sessionDrafts = { ...state.sessionDrafts }
            delete sessionDrafts[sessionId]
            return { sessionDrafts }
          })
        }
        await get().refreshSidebar()
      })
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
    },

    toggleProject: async (projectId) => {
      const collapsedProjects = { ...get().collapsedProjects }
      const expanding = collapsedProjects[projectId] === true
      if (expanding) delete collapsedProjects[projectId]
      else collapsedProjects[projectId] = true
      set({ collapsedProjects })
      persistCollapsedProjects(collapsedProjects)
      if (
        expanding &&
        get().sessionsByProject[sessionListKey(projectId)] === undefined
      ) {
        await get().loadSessions(projectId)
      }
    },

    addProject: async (path, name) => {
      const trimmed = path.trim()
      if (trimmed === "" || get().inFlightActions.has("project-open"))
        return false
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add("project-open"),
      }))
      const completed = await runTask(async () => {
        const { project } = await getAppRpcClient(get().apiBase).request(
          "project/open",
          {
            path: trimmed,
            ...(name === undefined ? {} : { name: name.trim() }),
          },
        )
        set((state) => ({
          projects: [
            ...state.projects.filter((entry) => entry.id !== project.id),
            project,
          ].sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) || a.position - b.position,
          ),
          collapsedProjects: Object.fromEntries(
            Object.entries(state.collapsedProjects).filter(
              ([id]) => id !== project.id,
            ),
          ),
        }))
        persistCollapsedProjects(get().collapsedProjects)
        window.localStorage.setItem("yakitori.project", project.id)
        get().startNewSession(project.id)
      })
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete("project-open")
        return { inFlightActions }
      })
      return completed
    },

    updateProject: async (projectId, input) => {
      const completed = await runTask(async () => {
        await getAppRpcClient(get().apiBase).request("project/update", {
          projectId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.roots === undefined ? {} : { roots: [...input.roots] }),
        })
      })
      if (completed) await get().loadProjects()
      return completed
    },

    removeProject: async (projectId) => {
      const completed = await runTask(async () => {
        await getAppRpcClient(get().apiBase).request("project/delete", {
          projectId,
        })
      })
      if (completed) await get().loadProjects()
      return completed
    },

    moveProject: async (projectId, targetId, after) => {
      if (get().inFlightActions.has("project-order")) return false
      const source = get().projects.find((project) => project.id === projectId)
      const target = get().projects.find((project) => project.id === targetId)
      if (
        !source ||
        !target ||
        source.id === target.id ||
        source.pinned !== target.pinned
      )
        return false
      const ordered = [...get().projects]
        .sort((a, b) => a.position - b.position)
        .filter((project) => project.id !== projectId)
      const position =
        ordered.findIndex((project) => project.id === targetId) +
        (after ? 1 : 0)
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add("project-order"),
      }))
      const done = await runTask(async () => {
        await getAppRpcClient(get().apiBase).request("project/move", {
          projectId,
          toPosition: position,
        })
        await get().loadProjects()
      })
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete("project-order")
        return { inFlightActions }
      })
      return done
    },

    toggleProjectPinned: async (projectId) => {
      const project = get().projects.find(
        (candidate) => candidate.id === projectId,
      )
      if (project === undefined) return false
      const completed = await runTask(async () => {
        await getAppRpcClient(get().apiBase).request("project/update", {
          projectId,
          pinned: !project.pinned,
        })
      })
      if (completed) await get().loadProjects()
      return completed
    },

    selectSession: async (sessionId, suppliedSummary) => {
      const summary = suppliedSummary ?? findSessionSummary(get(), sessionId)
      if (suppliedSummary !== undefined) {
        const key = sessionListKey(suppliedSummary.projectId, {
          ...(suppliedSummary.sectionId === undefined
            ? {}
            : { sectionId: suppliedSummary.sectionId }),
          ...(suppliedSummary.archived ? { archived: true } : {}),
        })
        set((state) => ({
          sessionsByProject: {
            ...state.sessionsByProject,
            [key]: {
              ...state.sessionsByProject[key],
              sessions: (state.sessionsByProject[key]?.sessions ?? []).some(
                (entry) =>
                  (entry.navigationId ?? entry.id) ===
                  (suppliedSummary.navigationId ?? suppliedSummary.id),
              )
                ? (state.sessionsByProject[key]?.sessions ?? []).map((entry) =>
                    (entry.navigationId ?? entry.id) ===
                    (suppliedSummary.navigationId ?? suppliedSummary.id)
                      ? suppliedSummary
                      : entry,
                  )
                : [
                    suppliedSummary,
                    ...(state.sessionsByProject[key]?.sessions ?? []),
                  ],
            },
          },
          collapsedProjects: Object.fromEntries(
            Object.entries(state.collapsedProjects).filter(
              ([id]) => id !== suppliedSummary.projectId,
            ),
          ),
        }))
        persistCollapsedProjects(get().collapsedProjects)
        if (suppliedSummary.sectionId && !suppliedSummary.archived)
          get().setSectionOpen(suppliedSummary.sectionId, true)
      }
      if (get().selection.sessionId === undefined)
        set({ newSessionPrompt: get().promptDraft })
      if (summary !== undefined) {
        set({ currentProject: summary.projectId })
        window.localStorage.setItem("yakitori.project", summary.projectId ?? "")
      }
      set((state) => ({
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        sessionDrafts: stashSessionDraft(state),
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
        selectedSession: undefined,
        sessionSkills: [],
        ...takeSessionDraft(get().sessionDrafts, sessionId),
      })
      connectEvents(selection, 0)
      loadSessionSkills(sessionId)
    },

    admitInput: async (text, attachments = []) => {
      if (get().selection.sessionId === undefined) {
        if (text === COMPACT_DIRECTIVE) return
        // Conversations start untitled; the server names the first input.
        const sessionId = await get().createSession()
        if (sessionId === undefined || get().selection.sessionId !== sessionId)
          return
        if (get().promptDraft === undefined) set({ promptDraft: text })
      }
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
      // A per-invocation requestId keeps a retried call from admitting a
      // duplicate compact directive.
      if (text === COMPACT_DIRECTIVE) {
        await runTask(
          async () => {
            const response = await getAppRpcClient(get().apiBase).request(
              "session/compact",
              {
                sessionId: selection.sessionId,
                requestId: createRequestId(),
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
            providers: state.providers,
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
          const response = await getAppRpcClient(get().apiBase).request(
            "session/input",
            {
              sessionId: selection.sessionId,
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
            set({
              promptDraft: undefined,
              promptAttachments: [],
            })
          }
          set((state) => {
            const inFlightActions = new Set(state.inFlightActions)
            inFlightActions.delete(key)
            return { inFlightActions }
          })
          if (!isCurrentSelection(selection)) return
          await get().refreshSidebar()
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
          try {
            await getAppRpcClient(get().apiBase).request(
              "session/turn/cancel",
              {
                sessionId: selection.sessionId,
                turnId,
                reason: "user_cancel",
              },
            )
          } catch (error) {
            if (
              error instanceof ApiRequestError &&
              error.code === "not_found" &&
              isCurrentSelection(selection)
            ) {
              connectEvents(selection, get().execution.lastSeq)
            }
            throw error
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
            await getAppRpcClient(get().apiBase).request(
              "session/input/cancel",
              {
                sessionId: selection.sessionId,
                inputId,
                reason: "user_cancel",
              },
            )
          } catch (error) {
            if (
              !(error instanceof ApiRequestError && error.code === "conflict")
            ) {
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

    // The answer channel correlates by permissionRequestId alone; the turnId
    // stays in the signature because the approval UI addresses a Turn.
    resolvePermission: async (_turnId, permissionRequestId, behavior) => {
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
          // Answering the server→client request replaces the old resolve
          // POST; the confirmation still arrives through the event stream.
          getAppRpcClient(get().apiBase).answerPermission(permissionRequestId, {
            behavior,
            reason: {
              kind: behavior === "allow" ? "user_allowed" : "user_denied",
            },
          })
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
      if (sessionId === undefined) {
        set({ draftModelSelection: selection })
        return
      }
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
          const response = await getAppRpcClient(apiBase).request(
            "userPreference/write",
            selection,
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
  readonly providers: readonly ApiProviderSummary[]
}): ModelSelection | undefined {
  if (isAvailableModel(input.sessionCurrent, input.providers)) {
    return input.sessionCurrent
  }
  if (isAvailableModel(input.userPreference, input.providers)) {
    return input.userPreference
  }
  if (input.defaultProvider === undefined || input.defaultModel === undefined) {
    return undefined
  }
  const fallback = {
    provider: input.defaultProvider,
    model: input.defaultModel,
  }
  return isAvailableModel(fallback, input.providers) ? fallback : undefined
}

function isAvailableModel(
  selection: ModelSelection | undefined,
  providers: readonly ApiProviderSummary[],
): selection is ModelSelection {
  if (selection === undefined) return false
  if (providers.length === 0) return true
  const provider = providers.find((entry) => entry.name === selection.provider)
  return (
    provider !== undefined &&
    provider.availability !== "requires_login" &&
    provider.models.some((model) => model.id === selection.model)
  )
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
  if (event.type === "turn.finished" && event.turnId === session.activeTurnId) {
    const { activeTurnId: _, ...withoutActiveTurn } = session
    return { ...withoutActiveTurn, active: false }
  }
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

// Both sides are Object.is-stable when no summary field would change, so
// durable stream events do not rebuild lists the selected session is not in.
function updateSessionSummary(
  sessions: ApiSessionSummary[],
  selectedSession: ApiSessionDetail | undefined,
): ApiSessionSummary[] {
  if (selectedSession === undefined) return sessions
  const index = sessions.findIndex(
    (session) => session.id === selectedSession.id,
  )
  const session = index < 0 ? undefined : sessions[index]
  if (
    session === undefined ||
    (session.seq === selectedSession.seq &&
      session.updatedAt === selectedSession.updatedAt)
  ) {
    return sessions
  }
  return sessions.map((entry, entryIndex) =>
    entryIndex === index
      ? {
          ...entry,
          seq: selectedSession.seq,
          updatedAt: selectedSession.updatedAt,
        }
      : entry,
  )
}

function updateSessionSummaryInLists(
  lists: Record<string, ProjectSessionList>,
  selectedSession: ApiSessionDetail | undefined,
): Record<string, ProjectSessionList> {
  if (selectedSession === undefined) return lists
  let changed = false
  const next = Object.fromEntries(
    Object.entries(lists).map(([key, list]) => {
      const sessions = updateSessionSummary(list.sessions, selectedSession)
      if (sessions === list.sessions) return [key, list]
      changed = true
      return [key, { ...list, sessions }]
    }),
  )
  return changed ? next : lists
}

export function findSessionSummary(
  state: AppStoreData,
  sessionId: string,
): ApiSessionSummary | undefined {
  for (const list of Object.values(state.sessionsByProject)) {
    const found = list.sessions.find((session) => session.id === sessionId)
    if (found !== undefined) return found
  }
  return undefined
}

function initialApiBase(): string {
  const queryApi = new URLSearchParams(window.location.search).get("api")
  if (queryApi) return queryApi
  return window.location.origin
}

function stashSessionDraft(state: AppStoreData): Record<string, SessionDraft> {
  const sessionId = state.selection.sessionId
  if (sessionId === undefined) return state.sessionDrafts
  const hasContent =
    (state.promptDraft ?? "").trim().length > 0 ||
    state.promptAttachments.length > 0
  const sessionDrafts = { ...state.sessionDrafts }
  if (hasContent) {
    sessionDrafts[sessionId] = {
      text: state.promptDraft,
      attachments: state.promptAttachments,
    }
  } else {
    delete sessionDrafts[sessionId]
  }
  return sessionDrafts
}

function takeSessionDraft(
  sessionDrafts: Record<string, SessionDraft>,
  sessionId: string,
): Pick<AppStoreData, "sessionDrafts" | "promptDraft" | "promptAttachments"> {
  const next = { ...sessionDrafts }
  const draft = next[sessionId]
  delete next[sessionId]
  return {
    sessionDrafts: next,
    promptDraft: draft?.text,
    promptAttachments: draft?.attachments ?? [],
  }
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

function initialCollapsedProjects(): Record<string, boolean> {
  const raw = window.localStorage.getItem("yakitori.collapsedProjects")
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
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === true),
    )
  } catch {
    return {}
  }
}

function persistCollapsedProjects(
  collapsedProjects: Readonly<Record<string, boolean>>,
): void {
  window.localStorage.setItem(
    "yakitori.collapsedProjects",
    JSON.stringify(collapsedProjects),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}
