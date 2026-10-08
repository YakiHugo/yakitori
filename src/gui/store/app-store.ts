import { useMemo } from "react"
import { create } from "zustand"
import { assetSourceKey } from "../../core/asset-types.ts"
import type { ThreadGoal } from "../../core/goal.ts"
import type {
  SessionSidebar,
  SidebarChange,
} from "../../core/session-sidebar.ts"
import type { InputDraft } from "../../core/user-input.ts"
import {
  inputContent,
  inputContentAttachments,
  inputContentText,
} from "../../core/user-input.ts"
import type { InputContent } from "../../kernel/events.ts"
import {
  COMPACT_DIRECTIVE,
  isKernelEvent,
  type ModelSelection,
  type StoredEventEnvelope,
  type UserAttachment,
} from "../../kernel/events.ts"
import { createRequestId } from "../../kernel/ids.ts"
import type { LiveSessionEvent } from "../../runtime/live-events.ts"
import type { QueuedInput } from "../../server/input-queue.ts"
import type {
  ApiAdmitInputResponse,
  ApiProject,
  ApiProviderSummary,
  ApiReadUsageResponse,
  ApiSessionDetail,
  ApiSessionSummary,
  ApiSetGoalRequest,
  ApiSkillSummary,
  ApiSubscriptionProvider,
  ApiSubscriptionSummary,
  ApiUserModelPreference,
} from "../../server/protocol.ts"
import type { ContextExcerpt } from "../conversation-context.ts"
import {
  createExecutionViewState,
  type ExecutionView,
  type ExecutionViewState,
  projectExecutionView,
  reduceExecutionView,
} from "../execution-view.ts"
import { inputAttachmentOwnership } from "../input-attachment-ownership.ts"
import {
  hasInputDraft,
  joinInputDrafts,
  sameInputDraft,
  textInputDraft,
  trimInputDraft,
} from "../input-draft.ts"
import {
  inputRecoveryMemory,
  type PendingAdmission,
  type StoredSteer,
} from "../input-recovery-memory.ts"
import {
  ApiRequestError,
  type AppRpcClient,
  getAppRpcClient,
  type SessionStream,
} from "../lib/rpc-client.ts"
import { useWorkspaceStore } from "./workspace-store.ts"

type SessionSelection = {
  readonly revision: number
  readonly sessionId: string
}

const firstInputDraftSessionId = "draft_first_input"

export type SessionDraft = Readonly<{
  content: InputDraft | undefined
  excerpts: readonly ContextExcerpt[]
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

export type SettingsSection =
  | "general"
  | "notifications"
  | "providers"
  | "subscriptions"
  | "mcp"
  | "usage"

export type UsageState = Readonly<{
  summary?: ApiReadUsageResponse["usage"]
  loading: boolean
  error?: string
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
  newSessionPrompt: InputDraft | undefined
  newSessionExcerpts: readonly ContextExcerpt[]
  promptDraft: InputDraft | undefined
  promptExcerpts: readonly ContextExcerpt[]
  queuedItems: readonly QueuedInput[]
  recoveredAdmission: PendingAdmission | undefined
  sessionDrafts: Record<string, SessionDraft>
  pendingSteers: Record<string, readonly StoredSteer[]>
  restoredSteerRequestIds: Readonly<Record<string, true>>
  // Skills discoverable in the selected session's working directory.
  sessionSkills: readonly ApiSkillSummary[]
  sessionSkillsError: string | undefined
  hydratingSessionId: string | undefined
  projects: ApiProject[]
  // Last project-list load failure; the sidebar keeps the last good list and
  // shows a retry note while this is set.
  projectsError: string | undefined
  providers: ApiProviderSummary[]
  providersError: string | undefined
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
  // The settings page replaces the main conversation area while set.
  settingsSection: SettingsSection | undefined
  usage: UsageState
  // Incremented to ask the session header to open its goal editor.
  goalDialogRevision: number
  modelPickerRevision: number
  renameDialogRevision: number
  commandPanel:
    | Readonly<{
        sessionId?: string
        kind: "status" | "mcp"
      }>
    | undefined
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
  moveSidebarSection(
    sectionId: string,
    direction: "up" | "down",
  ): Promise<boolean>
  loadProjects(): Promise<void>
  loadProviders(): Promise<void>
  loadSubscriptions(): Promise<void>
  startNewSession(projectId?: string): void
  setNewSessionProject(projectId?: string): void
  createSession(title?: string): Promise<string | undefined>
  deleteSession(sessionId: string): Promise<void>
  forkSession(
    atInputId: string,
    reason: "undo" | "edit",
    content?: InputContent,
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
    parts: InputDraft,
    // "queue" skips steering: the input joins the durable pending queue and
    // dispatches as the next Turn when the Session goes idle.
    mode?: "auto" | "queue",
  ): Promise<void>
  cancelTurn(turnId: string): Promise<void>
  cancelQueuedInput(inputId: string): Promise<void>
  refreshQueuedInputs(): Promise<void>
  updateQueuedInput(inputId: string, parts: InputDraft): Promise<void>
  reorderQueuedInputs(inputIds: readonly string[]): Promise<void>
  startQueuedInput(inputId: string): Promise<void>
  resolvePermission(
    turnId: string,
    permissionRequestId: string,
    behavior: "allow" | "deny",
  ): Promise<void>
  setPromptDraft(parts: InputDraft): void
  addPromptExcerpt(excerpt: ContextExcerpt): void
  removePromptExcerpt(id: string): void
  updatePromptExcerpt(excerpt: ContextExcerpt): void
  setModelSelection(
    sessionId: string | undefined,
    selection: ModelSelection | undefined,
  ): void
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  setSettingsSection(section: SettingsSection): void
  loadUsage(): Promise<void>
  openGoalDialog(): void
  setGoal(input: ApiSetGoalRequest): Promise<boolean>
  clearGoal(sessionId: string): Promise<boolean>
  openModelPicker(): void
  openRenameDialog(): void
  openCommandPanel(kind: "status" | "mcp"): void
  closeCommandPanel(): void
  // False while any provider's quota snapshot is missing or older than 30s.
  subscriptionsFresh(): boolean
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
      globalThis.localStorage.getItem("yakitori.collapsedSections") ?? "{}",
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
    newSessionExcerpts: [],
    promptDraft: undefined,
    promptExcerpts: [],
    queuedItems: [],
    recoveredAdmission: undefined,
    sessionDrafts: {},
    pendingSteers: {},
    restoredSteerRequestIds: {},
    sessionSkills: [],
    sessionSkillsError: undefined,
    hydratingSessionId: undefined,
    projects: [],
    projectsError: undefined,
    providers: [],
    providersError: undefined,
    subscriptionsByProvider: createInitialSubscriptionUsage(),
    userPreference: undefined,
    selection: {},
    sessionSelectionIntentRevision: 0,
    selectedSession: undefined,
    sessionsByProject: {},
    stream: undefined,
    currentProject: undefined,
    collapsedProjects: initialCollapsedProjects(),
    settingsSection: undefined,
    usage: { loading: false },
    goalDialogRevision: 0,
    modelPickerRevision: 0,
    renameDialogRevision: 0,
    commandPanel: undefined,
  }
}

let activeTaskCount = 0

export const useAppStore = create<AppStore>()((set, get) => {
  const sessionListRevisions: Record<string, number> = {}
  // Snapshot identity distinguishes a later clear from an earlier null goal.
  const goalSnapshots = new Map<string, Readonly<{ goal: ThreadGoal | null }>>()
  let sidebarReadRevision = 0
  let projectReadRevision = 0
  // Sidebar mutations are serialized through this chain so rapid pin/move
  // clicks each reach the server in click order instead of being dropped
  // while an earlier change is in flight. runTask never rejects, so a failed
  // change cannot wedge the queue.
  let sidebarQueue: Promise<boolean> = Promise.resolve(true)
  let sidebarQueueDepth = 0
  let sidebarQueueError: string | undefined
  let newSessionCreation:
    | { revision: number; promise: Promise<string | undefined> }
    | undefined
  const pendingCreateIntents = new Set<number>()
  const createNewSessionForCurrentIntent = (): void => {
    const creation = get().createSession()
    const pending = {
      revision: get().sessionSelectionIntentRevision,
      promise: creation,
    }
    newSessionCreation = pending
    void creation.then(() => {
      if (newSessionCreation === pending) newSessionCreation = undefined
    })
  }
  const pendingSidebarSessionIds = new Set<string>()
  const pendingSidebarPins = new Map<
    string,
    { readonly navigationId: string; readonly sectionId: string | null }
  >()
  const confirmedSidebarPins = new Set<string>()
  const supersededSidebarPins = new Set<string>()
  const projectPinRevisions: Record<string, number> = {}
  const confirmedProjectPins: Record<string, boolean> = {}
  const pendingProjectPins: Record<string, number> = {}
  const inFlightAdmissions = new Set<string>()
  const rejectedAdmissions = new Set<string>()
  const inFlightSteerRequests = new Set<string>()
  const committedSteerRequests = new Set<string>()
  // Set only after a complete replay or a durable terminal event. A live
  // snapshot alone may still have subsequent history to deliver.
  const authoritativeTurns = new Map<string, string | undefined>()
  const subscriptionReadRevisions: Record<ApiSubscriptionProvider, number> = {
    codex: 0,
    grok: 0,
    kimi: 0,
  }
  let projectChangesSubscribedClient: AppRpcClient | undefined
  let providersReadRevision = 0
  let queueReadRevision = 0
  const runTask = async (
    task: () => Promise<void>,
    isCurrent: () => boolean = () => true,
    clearMessage = true,
    tracksBusy = true,
  ): Promise<boolean> => {
    if (tracksBusy) {
      activeTaskCount += 1
      set({ busy: true })
    }
    if (clearMessage && isCurrent()) set({ message: undefined })
    try {
      await task()
      return true
    } catch (error) {
      if (isCurrent()) set({ message: errorMessage(error, "Request failed.") })
      return false
    } finally {
      if (tracksBusy) {
        activeTaskCount -= 1
        set({ busy: activeTaskCount > 0 })
      }
    }
  }
  const invalidateSessionListReads = (): void => {
    for (const key of Object.keys(get().sessionsByProject)) {
      sessionListRevisions[key] = (sessionListRevisions[key] ?? 0) + 1
    }
  }

  const enqueueSidebarChange = (
    resolveChange: () => SidebarChange | undefined,
  ): Promise<boolean> => {
    if (sidebarQueueDepth === 0) {
      sidebarQueueError = undefined
      set({ message: undefined })
    }
    sidebarQueueDepth += 1
    set((state) => ({
      inFlightActions: new Set(state.inFlightActions).add("sidebar-update"),
    }))
    const run = sidebarQueue.then(async () => {
      const change = resolveChange()
      if (change === undefined) return false
      const sessionChange =
        change.type === "session" || change.type === "move-session"
          ? change
          : undefined
      const pinChange =
        (change.type === "session" ||
          (change.type === "move-session" &&
            change.beforeSessionId === undefined)) &&
        (change.sectionId === "pinned" || change.sectionId === null)
          ? change
          : undefined
      const changedSession =
        sessionChange === undefined
          ? undefined
          : findCachedSession(get(), sessionChange.sessionId)
      if (sessionChange !== undefined)
        pendingSidebarSessionIds.add(sessionChange.sessionId)
      if (pinChange !== undefined && changedSession !== undefined) {
        confirmedSidebarPins.delete(pinChange.sessionId)
        supersededSidebarPins.delete(pinChange.sessionId)
        pendingSidebarPins.set(pinChange.sessionId, {
          navigationId: changedSession.navigationId ?? changedSession.id,
          sectionId: pinChange.sectionId ?? null,
        })
      }
      const previousSidebar =
        pinChange === undefined ? undefined : get().sidebar
      if (previousSidebar !== undefined && pinChange !== undefined) {
        const sidebar = optimisticPinnedSidebar(get(), {
          sessionId: pinChange.sessionId,
          sectionId: pinChange.sectionId ?? null,
        })
        if (sidebar !== undefined) {
          sidebarReadRevision += 1
          invalidateSessionListReads()
          set((state) =>
            projectSidebarSession(
              state,
              sidebar,
              pinChange.sessionId,
              changedSession,
            ),
          )
        }
      }
      let completed = await runTask(
        async () => {
          const sidebar = await getAppRpcClient(get().apiBase).request(
            "sidebar/update",
            change,
          )
          sidebarReadRevision += 1
          invalidateSessionListReads()
          set((state) =>
            sessionChange !== undefined
              ? projectSidebarSession(
                  state,
                  sidebar,
                  sessionChange.sessionId,
                  changedSession,
                )
              : { sidebar },
          )
          if (sessionChange?.sectionId)
            get().setSectionOpen(sessionChange.sectionId, true)
        },
        () => true,
        false,
      )
      if (
        !completed &&
        pinChange !== undefined &&
        confirmedSidebarPins.has(pinChange.sessionId)
      ) {
        completed = true
        set({ message: undefined })
      }
      if (!completed) {
        sidebarQueueError = get().message
        if (
          previousSidebar !== undefined &&
          pinChange !== undefined &&
          !supersededSidebarPins.has(pinChange.sessionId)
        ) {
          sidebarReadRevision += 1
          invalidateSessionListReads()
          set((state) => {
            const sidebar =
              changedSession === undefined
                ? previousSidebar
                : restoreSidebarSection(
                    state.sidebar,
                    previousSidebar,
                    changedSession.navigationId ?? changedSession.id,
                  )
            return projectSidebarSession(
              state,
              sidebar,
              pinChange.sessionId,
              changedSession,
            )
          })
        }
      } else if (sidebarQueueError !== undefined) {
        set({ message: sidebarQueueError })
      }
      if (sessionChange !== undefined)
        pendingSidebarSessionIds.delete(sessionChange.sessionId)
      if (pinChange !== undefined) {
        pendingSidebarPins.delete(pinChange.sessionId)
        confirmedSidebarPins.delete(pinChange.sessionId)
        supersededSidebarPins.delete(pinChange.sessionId)
      }
      return completed
    })
    sidebarQueue = run
    void run.then(() => {
      sidebarQueueDepth -= 1
      if (sidebarQueueDepth !== 0) return
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete("sidebar-update")
        return { inFlightActions }
      })
    })
    return run
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

  const sameResolvedDraft = (left: InputDraft, right: InputDraft) =>
    sameInputDraft(
      inputAttachmentOwnership.resolveDraft(get().apiBase, left),
      inputAttachmentOwnership.resolveDraft(get().apiBase, right),
    )
  const recordPromotedContent = (
    original: InputContent,
    accepted: InputContent,
  ) => {
    if (!original.attachments.length) return
    inputAttachmentOwnership.promote(get().apiBase, original, accepted)
    set((state) => ({
      promptDraft:
        state.promptDraft === undefined
          ? undefined
          : inputAttachmentOwnership.resolveDraft(
              state.apiBase,
              state.promptDraft,
            ),
      newSessionPrompt:
        state.newSessionPrompt === undefined
          ? undefined
          : inputAttachmentOwnership.resolveDraft(
              state.apiBase,
              state.newSessionPrompt,
            ),
      sessionDrafts: Object.fromEntries(
        Object.entries(state.sessionDrafts).map(([id, draft]) => [
          id,
          {
            ...draft,
            content:
              draft.content === undefined
                ? undefined
                : inputAttachmentOwnership.resolveDraft(
                    state.apiBase,
                    draft.content,
                  ),
          },
        ]),
      ),
    }))
  }

  const restoreUncommittedSteers = (
    sessionId: string,
    turnId?: string,
  ): void => {
    set((state) => {
      const pending = state.pendingSteers[sessionId] ?? []
      const restoring = pending.filter(
        (steer) => turnId === undefined || steer.turnId === turnId,
      )
      if (restoring.length === 0) return state
      const pendingSteers = {
        ...state.pendingSteers,
        [sessionId]: pending.filter((steer) => !restoring.includes(steer)),
      }
      inputRecoveryMemory.updateSteers(state.apiBase, sessionId, (steers) =>
        steers.map((steer) =>
          restoring.some((item) => item.requestId === steer.requestId)
            ? { ...steer, restored: true }
            : steer,
        ),
      )
      const restoredSteerRequestIds = {
        ...state.restoredSteerRequestIds,
        ...Object.fromEntries(
          restoring.map((steer) => [steer.requestId, true] as const),
        ),
      }
      const selected = state.selection.sessionId === sessionId
      const draft: SessionDraft = selected
        ? {
            content: state.promptDraft,
            excerpts: state.promptExcerpts,
          }
        : (state.sessionDrafts[sessionId] ?? {
            content: undefined,
            excerpts: [],
          })
      // A reply can arrive after replay has already restored its pending
      // submission; the original composer may still contain that same text.
      const last = restoring.at(-1)
      const alreadyInDraft =
        last !== undefined &&
        sameResolvedDraft(
          trimInputDraft(draft.content ?? textInputDraft("")),
          last.content,
        )
      const toPrepend = alreadyInDraft ? restoring.slice(0, -1) : restoring
      const restored: SessionDraft = {
        content: inputAttachmentOwnership.resolveDraft(
          state.apiBase,
          joinInputDrafts([
            ...toPrepend.map((steer) => steer.content),
            draft.content,
          ]),
        ),
        excerpts: [
          ...restoring.flatMap((steer) =>
            (steer.content.references ?? []).filter(
              (excerpt) =>
                !draft.excerpts.some((current) => current.id === excerpt.id),
            ),
          ),
          ...draft.excerpts,
        ],
      }
      return selected
        ? {
            pendingSteers,
            restoredSteerRequestIds,
            promptDraft: restored.content,
            promptExcerpts: restored.excerpts,
          }
        : {
            pendingSteers,
            restoredSteerRequestIds,
            sessionDrafts: { ...state.sessionDrafts, [sessionId]: restored },
          }
    })
  }

  const restoreUncommittedAdmission = (
    sessionId: string,
    requestId: string,
  ): void => {
    if (get().execution.admittedRequestIds[requestId]) return
    const admission = inputRecoveryMemory.readAdmissionByRequestId(
      get().apiBase,
      sessionId,
      requestId,
    )
    if (admission === undefined) return
    if (inFlightAdmissions.has(requestId)) rejectedAdmissions.add(requestId)
    inputRecoveryMemory.acknowledgeAdmission(admission)
    set((state) => {
      const selected = state.selection.sessionId === sessionId
      const draft: SessionDraft = selected
        ? {
            content: state.promptDraft,
            excerpts: state.promptExcerpts,
          }
        : (state.sessionDrafts[sessionId] ?? {
            content: undefined,
            excerpts: [],
          })
      const alreadyInDraft = sameResolvedDraft(
        trimInputDraft(draft.content ?? textInputDraft("")),
        admission.content,
      )
      const restored: SessionDraft = {
        content: alreadyInDraft
          ? draft.content
          : inputAttachmentOwnership.resolveDraft(
              state.apiBase,
              joinInputDrafts([admission.content, draft.content]),
            ),
        excerpts: [
          ...(admission.content.references ?? []).filter(
            (excerpt) =>
              !draft.excerpts.some((current) => current.id === excerpt.id),
          ),
          ...draft.excerpts,
        ],
      }
      return selected
        ? {
            promptDraft: restored.content,
            promptExcerpts: restored.excerpts,
          }
        : {
            sessionDrafts: { ...state.sessionDrafts, [sessionId]: restored },
          }
    })
  }

  const retireRestoredSteers = (sessionId: string): void => {
    const ids = inputRecoveryMemory
      .readSteers(get().apiBase, sessionId)
      .flatMap((steer) =>
        steer.restored && get().restoredSteerRequestIds[steer.requestId]
          ? [steer.requestId]
          : [],
      )
    if (ids.length === 0) return
    inputRecoveryMemory.updateSteers(get().apiBase, sessionId, (steers) =>
      steers.filter((steer) => !ids.includes(steer.requestId)),
    )
    set((state) => ({
      restoredSteerRequestIds: Object.fromEntries(
        Object.entries(state.restoredSteerRequestIds).filter(
          ([requestId]) => !ids.includes(requestId),
        ),
      ),
    }))
  }

  const closeStream = (): void => {
    get().stream?.close()
    set({ stream: undefined })
  }

  const loadSkills = (
    owner: Readonly<{ sessionId?: string; projectId?: string }>,
  ): void => {
    const revision = get().sessionSelectionIntentRevision
    const apiBase = get().apiBase
    set({ sessionSkills: [], sessionSkillsError: undefined })
    void getAppRpcClient(apiBase)
      .request("session/skills", owner)
      .then((response) => {
        if (
          get().selection.sessionId !== owner.sessionId ||
          get().sessionSelectionIntentRevision !== revision ||
          (owner.projectId !== undefined &&
            get().currentProject !== owner.projectId) ||
          get().apiBase !== apiBase
        ) {
          return
        }
        set({ sessionSkills: response.skills })
      })
      .catch((error: unknown) => {
        if (
          get().selection.sessionId !== owner.sessionId ||
          get().sessionSelectionIntentRevision !== revision ||
          (owner.projectId !== undefined &&
            get().currentProject !== owner.projectId) ||
          get().apiBase !== apiBase
        )
          return
        set({
          sessionSkillsError: errorMessage(error, "Could not load skills."),
        })
      })
  }
  const loadSessionSkills = (sessionId: string): void =>
    loadSkills({ sessionId })
  const loadDraftSkills = (projectId: string | undefined): void => {
    if (projectId) loadSkills({ projectId })
    else set({ sessionSkills: [], sessionSkillsError: undefined })
  }

  const connectEvents = (selection: SessionSelection, after: number): void => {
    if (!isCurrentSelection(selection)) return
    closeStream()
    authoritativeTurns.delete(selection.sessionId)
    set((state) => ({
      pendingSteers: {
        ...state.pendingSteers,
        [selection.sessionId]: inputRecoveryMemory
          .readSteers(state.apiBase, selection.sessionId)
          .filter((steer) => !state.restoredSteerRequestIds[steer.requestId]),
      },
    }))
    if (after === 0) set({ hydratingSessionId: selection.sessionId })

    let replaySnapshot: ApiSessionDetail | undefined
    const goalAtSubscribe = goalSnapshots.get(selection.sessionId)
    try {
      const source = getAppRpcClient(get().apiBase).openSessionStream(
        selection.sessionId,
        after,
        {
          onSnapshot: (response) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            const latestGoal = goalSnapshots.get(selection.sessionId)
            if (latestGoal !== undefined && latestGoal !== goalAtSubscribe)
              response = {
                ...response,
                session: withGoal(response.session, latestGoal.goal),
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
              hydratingSessionId: selection.sessionId,
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
              ...(state.message === "The connection to the server was lost."
                ? { message: undefined }
                : {}),
              execution:
                snapshot === undefined
                  ? state.execution
                  : reduceExecutionView(state.execution, {
                      type: "replay_completed",
                      session: snapshot,
                    }),
            }))
            authoritativeTurns.set(
              selection.sessionId,
              get().execution.activeTurnId,
            )
            if (get().execution.activeTurnId !== undefined) {
              for (const steer of get().pendingSteers[selection.sessionId] ??
                []) {
                if (
                  steer.restored ||
                  steer.turnId !== get().execution.activeTurnId
                )
                  restoreUncommittedSteers(selection.sessionId, steer.turnId)
              }
            } else {
              restoreUncommittedSteers(selection.sessionId)
            }
            if (get().restoringModelSelectionFor === selection.sessionId) {
              set({ restoringModelSelectionFor: undefined })
            }
            void (async () => {
              const recoverableRequests = new Set(
                inputRecoveryMemory
                  .listAdmissionsForSession(get().apiBase, selection.sessionId)
                  .filter(
                    (admission) => !inFlightAdmissions.has(admission.requestId),
                  )
                  .map((admission) => admission.requestId),
              )
              let queuedRequestIds = new Set<string>()
              try {
                const queue = await getAppRpcClient(get().apiBase).request(
                  "session/queue/list",
                  { sessionId: selection.sessionId },
                )
                queuedRequestIds = new Set(
                  queue.items.map((item) => item.input.submissionId),
                )
                for (const item of queue.items) {
                  const pending = inputRecoveryMemory.readAdmissionByRequestId(
                    get().apiBase,
                    selection.sessionId,
                    item.input.submissionId,
                  )
                  if (pending)
                    recordPromotedContent(pending.content, item.input.content)
                }
              } catch {
                // A failed queue lookup leaves the in-memory snapshot available
                // for retry. Restoring it favors recovery over deduplication.
              }
              if (!isCurrentSelection(selection)) return
              const execution = get().execution
              for (const admission of inputRecoveryMemory.listAdmissionsForSession(
                get().apiBase,
                selection.sessionId,
              )) {
                if (
                  execution.admittedRequestIds[admission.requestId] ||
                  queuedRequestIds.has(admission.requestId)
                ) {
                  inputRecoveryMemory.acknowledgeAdmission(admission)
                } else if (
                  recoverableRequests.has(admission.requestId) &&
                  !inFlightAdmissions.has(admission.requestId) &&
                  execution.activeTurnId !== admission.requestId
                ) {
                  // Recover only pre-existing orphaned submissions. An idle
                  // snapshot cannot reject sends overlapping this queue read.
                  restoreUncommittedAdmission(
                    selection.sessionId,
                    admission.requestId,
                  )
                }
              }
            })()
          },
          onEvent: (event) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            if (event.sessionId !== selection.sessionId) return
            if (isKernelEvent(event) && event.type === "input.admitted") {
              if (
                event.type === "input.admitted" &&
                inFlightSteerRequests.has(event.data.requestId)
              )
                committedSteerRequests.add(event.data.requestId)
              const admission = inputRecoveryMemory.readAdmissionByRequestId(
                get().apiBase,
                selection.sessionId,
                event.data.requestId,
              )
              const steer = inputRecoveryMemory
                .readSteers(get().apiBase, selection.sessionId)
                .find(
                  (candidate) => candidate.requestId === event.data.requestId,
                )
              const original = admission?.content ?? steer?.content
              if (original !== undefined)
                recordPromotedContent(original, event.data.content)
              if (admission !== undefined)
                inputRecoveryMemory.acknowledgeAdmission(admission)
              inputRecoveryMemory.updateSteers(
                get().apiBase,
                selection.sessionId,
                (steers) =>
                  steers.filter(
                    (steer) => steer.requestId !== event.data.requestId,
                  ),
              )
              set((state) => ({
                pendingSteers: {
                  ...state.pendingSteers,
                  [selection.sessionId]: (
                    state.pendingSteers[selection.sessionId] ?? []
                  ).filter((steer) => steer.requestId !== event.data.requestId),
                },
                restoredSteerRequestIds: Object.fromEntries(
                  Object.entries(state.restoredSteerRequestIds).filter(
                    ([requestId]) => requestId !== event.data.requestId,
                  ),
                ),
              }))
            }
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
            if (isKernelEvent(event) && event.type === "turn.completed") {
              authoritativeTurns.set(
                selection.sessionId,
                get().execution.activeTurnId,
              )
              restoreUncommittedSteers(selection.sessionId, event.data.turnId)
              restoreUncommittedAdmission(
                selection.sessionId,
                event.data.turnId,
              )
            }
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
          onDisconnected: (error) => {
            if (get().stream !== source || !isCurrentSelection(selection)) {
              return
            }
            set({
              hydratingSessionId: undefined,
              execution: reduceExecutionView(get().execution, {
                type: "stream_unavailable",
              }),
              message: errorMessage(
                error,
                "The connection to the server was lost.",
              ),
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
        client.subscribeToProviderChanges(() => {
          if (getAppRpcClient(get().apiBase) !== client) return
          void get().loadProviders()
        })
        goalSnapshots.clear()
        client.subscribeToGoalChanges((notification) => {
          if (getAppRpcClient(get().apiBase) !== client) return
          if (notification === undefined) {
            goalSnapshots.clear()
            const sessionId = get().selection.sessionId
            if (sessionId !== undefined)
              void runTask(
                async () => {
                  const response = await client.request("goal/read", {
                    sessionId,
                  })
                  if (
                    getAppRpcClient(get().apiBase) !== client ||
                    goalSnapshots.has(sessionId)
                  )
                    return
                  goalSnapshots.set(sessionId, { goal: response.goal })
                  set((state) => projectGoal(state, sessionId, response.goal))
                },
                () => getAppRpcClient(get().apiBase) === client,
                false,
                false,
              )
            return
          }
          goalSnapshots.set(notification.sessionId, { goal: notification.goal })
          set((state) =>
            projectGoal(state, notification.sessionId, notification.goal),
          )
        })
        client.subscribeToSidebarChanges((notification) => {
          const sidebar = notification.sidebar
          const sessionId = notification.sessionId
          if (sidebar !== undefined && sessionId !== undefined) {
            const pendingPin = pendingSidebarPins.get(sessionId)
            if (
              pendingPin !== undefined &&
              (sidebar.entries[pendingPin.navigationId]?.sectionId ?? null) ===
                pendingPin.sectionId
            ) {
              confirmedSidebarPins.add(sessionId)
            } else if (pendingPin !== undefined) {
              supersededSidebarPins.add(sessionId)
            }
            const session = findCachedSession(get(), sessionId)
            if (
              session !== undefined ||
              pendingSidebarSessionIds.has(sessionId)
            ) {
              sidebarReadRevision += 1
              invalidateSessionListReads()
              set((state) =>
                projectSidebarSession(state, sidebar, sessionId, session),
              )
              return
            }
          }
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
        client.subscribeToQueueChanges((sessionId) => {
          if (get().selection.sessionId === sessionId)
            void get().refreshQueuedInputs()
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
      const admissions = inputRecoveryMemory.listAdmissionsForApiBase(
        get().apiBase,
      )
      const superseded = new Set(
        admissions.flatMap((admission) =>
          admission.supersedesRequestId === undefined
            ? []
            : [admission.supersedesRequestId],
        ),
      )
      for (const admission of admissions) {
        if (superseded.has(admission.requestId))
          inputRecoveryMemory.acknowledgeAdmission(admission)
      }
      const pending = admissions
        .filter((admission) => !superseded.has(admission.requestId))
        .at(-1)
      if (pending !== undefined) {
        let missing = pending.sessionId === firstInputDraftSessionId
        if (!missing) {
          try {
            await client.request("session/read", {
              sessionId: pending.sessionId,
            })
            if (get().sessionSelectionIntentRevision !== intentRevision) return
            await get().selectSession(pending.sessionId)
            return
          } catch (error) {
            if (
              !(error instanceof ApiRequestError) ||
              error.code !== "not_found"
            ) {
              throw error
            }
            missing = true
          }
        }
        if (
          missing &&
          get().sessionSelectionIntentRevision === intentRevision
        ) {
          closeStream()
          set({
            selection: {},
            selectedSession: undefined,
            execution: createExecutionViewState(),
            promptDraft: inputAttachmentOwnership.resolveDraft(
              get().apiBase,
              pending.content,
            ),
            promptExcerpts: pending.content.references ?? [],
            recoveredAdmission: pending,
          })
          return
        }
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
      const goalsAtRequest = new Map(goalSnapshots)
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
          const sessions = response.sessions.map((session) => {
            const latestGoal = goalSnapshots.get(session.id)
            return latestGoal !== undefined &&
              latestGoal !== goalsAtRequest.get(session.id)
              ? withGoal(session, latestGoal.goal)
              : session
          })
          set((state) => {
            const current = state.sessionsByProject[key]
            return {
              sessionsByProject: {
                ...state.sessionsByProject,
                [key]: {
                  sessions: input.append
                    ? [
                        ...new Map(
                          [...(current?.sessions ?? []), ...sessions].map(
                            (session) => [
                              session.navigationId ?? session.id,
                              session,
                            ],
                          ),
                        ).values(),
                      ]
                    : sessions,
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
      globalThis.localStorage.setItem(
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
    changeSidebar: (change) => enqueueSidebarChange(() => change),

    moveSidebarSection: (sectionId, direction) =>
      enqueueSidebarChange(() => {
        const sectionIds = get().sidebar.sections.map((section) => section.id)
        const index = sectionIds.indexOf(sectionId)
        const target = index + (direction === "up" ? -1 : 1)
        if (index < 0 || target < 0 || target >= sectionIds.length) return
        const [removed] = sectionIds.splice(index, 1)
        if (removed === undefined) return
        sectionIds.splice(target, 0, removed)
        return { type: "reorder-sections", sectionIds }
      }),

    loadProjects: async () => {
      const revision = ++projectReadRevision
      try {
        const response = await getAppRpcClient(get().apiBase).request(
          "project/list",
          {},
        )
        if (revision !== projectReadRevision) return
        const projects = [...response.projects]
        for (const project of projects) {
          if ((pendingProjectPins[project.id] ?? 0) > 0) {
            confirmedProjectPins[project.id] = project.pinned
          }
        }
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
          const remembered = globalThis.localStorage.getItem("yakitori.project")
          // An empty remembered value is an explicit "No project" choice
          // (written by setNewSessionProject/selectSession); only a missing
          // key falls back to the first project.
          const currentProject =
            state.currentProject !== undefined &&
            liveIds.has(state.currentProject)
              ? state.currentProject
              : remembered === ""
                ? undefined
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
        if (get().selection.sessionId === undefined)
          loadDraftSkills(get().currentProject)
      } catch (error) {
        if (revision !== projectReadRevision) return
        // Servers without a project store answer not_found; the switcher
        // stays hidden there. Other failures keep the last good list and
        // surface a retry note instead of silently showing an empty sidebar.
        if (error instanceof ApiRequestError && error.code === "not_found") {
          set({ projectsError: undefined })
          return
        }
        set({ projectsError: "Could not load projects." })
      }
    },

    loadProviders: async () => {
      const apiBase = get().apiBase
      const revision = ++providersReadRevision
      try {
        const response = await getAppRpcClient(apiBase).request(
          "provider/list",
          {},
        )
        if (revision !== providersReadRevision || apiBase !== get().apiBase)
          return
        set({
          providers: [...response.providers],
          providersError: undefined,
          defaultProvider: response.defaultProvider,
          defaultModel: response.defaultModel,
          userPreference: response.userPreference,
        })
      } catch (error) {
        if (!(error instanceof ApiRequestError)) throw error
        if (revision !== providersReadRevision || apiBase !== get().apiBase)
          return
        set({ providersError: error.message })
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
      if (
        get().selection.sessionId === undefined &&
        get().currentProject === projectId &&
        newSessionCreation?.revision === get().sessionSelectionIntentRevision
      )
        return
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
        commandPanel: undefined,
        settingsSection: undefined,
        promptExcerpts:
          state.selection.sessionId === undefined
            ? state.promptExcerpts
            : state.newSessionExcerpts,
        promptDraft:
          state.selection.sessionId === undefined
            ? state.promptDraft
            : state.newSessionPrompt,
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        composerFocusRevision: state.composerFocusRevision + 1,
      })
      loadDraftSkills(projectId)
      createNewSessionForCurrentIntent()
    },

    setNewSessionProject: (projectId) => {
      const state = get()
      if (state.currentProject === projectId) return
      set({
        currentProject: projectId,
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
      })
      if (state.selection.sessionId === undefined) loadDraftSkills(projectId)
      globalThis.localStorage.setItem("yakitori.project", projectId ?? "")
      // The dropdown changes the destination of the current draft, including
      // its staged attachments. Supersede the old request and create there.
      if (state.selection.sessionId === undefined && newSessionCreation)
        createNewSessionForCurrentIntent()
    },

    createSession: async (title) => {
      if (pendingCreateIntents.has(get().sessionSelectionIntentRevision)) return
      let createdId: string | undefined
      const intentRevision = get().sessionSelectionIntentRevision + 1
      pendingCreateIntents.add(intentRevision)
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

          if (get().sessionSelectionIntentRevision !== intentRevision) {
            // Creation succeeded after its draft was abandoned. The session
            // has no owner; discard it through the same API as explicit delete.
            if (get().selection.sessionId !== response.session.id) {
              try {
                await getAppRpcClient(get().apiBase).request("session/delete", {
                  sessionId: response.session.id,
                })
              } catch (error) {
                set({
                  message: `Could not remove abandoned conversation ${response.session.id}: ${errorMessage(error, "Request failed.")}`,
                })
              }
            }
            return
          }
          if (
            project !== undefined &&
            get().collapsedProjects[project.id] === true
          ) {
            const collapsedProjects = { ...get().collapsedProjects }
            delete collapsedProjects[project.id]
            set({ collapsedProjects })
            persistCollapsedProjects(collapsedProjects)
          }
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
          set({ newSessionPrompt: undefined, newSessionExcerpts: [] })
          const draftAtCreation =
            get().selection.sessionId === undefined
              ? get().promptDraft
              : undefined
          const excerptsAtCreation =
            get().selection.sessionId === undefined ? get().promptExcerpts : []
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
            promptExcerpts: excerptsAtCreation,
          })
          connectEvents(selection, response.event.seq)
          loadSessionSkills(response.session.id)
        },
        () => get().sessionSelectionIntentRevision === intentRevision,
        true,
        false,
      )
      pendingCreateIntents.delete(intentRevision)
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
                    content,
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
        useWorkspaceStore.getState().removeSession(sessionId)
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
              promptExcerpts: [],
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
        globalThis.localStorage.setItem("yakitori.project", project.id)
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
      const revision = (projectPinRevisions[projectId] ?? 0) + 1
      projectPinRevisions[projectId] = revision
      if ((pendingProjectPins[projectId] ?? 0) === 0)
        confirmedProjectPins[projectId] = project.pinned
      pendingProjectPins[projectId] = (pendingProjectPins[projectId] ?? 0) + 1
      const optimistic = { ...project, pinned: !project.pinned }
      set((state) => ({
        projects: replaceProject(state.projects, optimistic),
      }))
      const completed = await runTask(async () => {
        const { project: updated } = await getAppRpcClient(
          get().apiBase,
        ).request("project/update", {
          projectId,
          pinned: optimistic.pinned,
        })
        confirmedProjectPins[projectId] = updated.pinned
        if (projectPinRevisions[projectId] !== revision) return
        set((state) => ({
          projects: replaceProject(state.projects, updated),
        }))
      })
      if (!completed && projectPinRevisions[projectId] === revision) {
        set((state) => {
          const current = state.projects.find(
            (candidate) => candidate.id === projectId,
          )
          if (current === undefined) return {}
          return {
            projects: replaceProject(state.projects, {
              ...current,
              pinned: confirmedProjectPins[projectId] ?? project.pinned,
            }),
          }
        })
      }
      pendingProjectPins[projectId] -= 1
      if (pendingProjectPins[projectId] === 0) {
        delete pendingProjectPins[projectId]
        delete confirmedProjectPins[projectId]
      }
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
        set({
          newSessionPrompt: get().promptDraft,
          newSessionExcerpts: get().promptExcerpts,
        })
      if (summary !== undefined) {
        set({ currentProject: summary.projectId })
        globalThis.localStorage.setItem(
          "yakitori.project",
          summary.projectId ?? "",
        )
      }
      set((state) => ({
        sessionSelectionIntentRevision:
          state.sessionSelectionIntentRevision + 1,
        sessionDrafts: stashSessionDraft(state),
      }))
      queueReadRevision += 1
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
        queuedItems: [],
        selectedSession: undefined,
        sessionSkills: [],
        commandPanel: undefined,
        settingsSection: undefined,
        ...takeSessionDraft(get().sessionDrafts, sessionId),
      })
      connectEvents(selection, 0)
      void get().refreshQueuedInputs()
      loadSessionSkills(sessionId)
    },

    admitInput: async (parts, mode = "auto") => {
      const excerpts = get().promptExcerpts
      const content: InputContent = inputContent(
        parts,
        { ...(excerpts.length ? { references: excerpts } : {}) }.references,
      )
      const text = inputContentText(content)
      const attachments = inputContentAttachments(content)
      if (text === COMPACT_DIRECTIVE && excerpts.length > 0) return
      let queuedModelSelection: ModelSelection | undefined
      let queuedForCreation = false
      let firstInputAdmission: PendingAdmission | undefined
      if (get().selection.sessionId === undefined) {
        if (text === COMPACT_DIRECTIVE) return
        const revision = get().sessionSelectionIntentRevision
        const queuedKey = `queue-first-input:${revision}`
        if (get().inFlightActions.has(queuedKey)) return
        const pendingCreation =
          newSessionCreation?.revision === revision
            ? newSessionCreation.promise
            : undefined
        queuedForCreation = true
        const state = get()
        queuedModelSelection = normalizeKimiModelSelection(
          resolveEffectiveModel({
            sessionCurrent: state.draftModelSelection,
            userPreference: state.userPreference,
            defaultProvider: state.defaultProvider,
            defaultModel: state.defaultModel,
            providers: state.providers,
          }),
          state.providers,
        )
        set((current) => ({
          inFlightActions: new Set(current.inFlightActions).add(queuedKey),
        }))
        // A newly opened draft already has a create request in flight. Direct
        // first sends still use the explicit create action when needed.
        let sessionId: string | undefined
        try {
          firstInputAdmission =
            state.recoveredAdmission ??
            inputRecoveryMemory.reserveAdmission({
              apiBase: state.apiBase,
              sessionId: firstInputDraftSessionId,
              content,
              ...(queuedModelSelection === undefined
                ? {}
                : { modelSelection: queuedModelSelection }),
            })
          if (state.promptDraft === undefined) set({ promptDraft: parts })
          const creation = pendingCreation ?? get().createSession()
          sessionId = await creation
        } finally {
          set((current) => {
            const inFlightActions = new Set(current.inFlightActions)
            inFlightActions.delete(queuedKey)
            return { inFlightActions }
          })
        }
        if (sessionId === undefined || get().selection.sessionId !== sessionId)
          return
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

      // An active Turn takes follow-up input as steering (Codex turn/steer);
      // the input is recorded when the Turn next samples. If the Turn ended
      // or stopped accepting between our view and the server, fall through to
      // a queued admission — it dispatches as the next Turn (or starts at
      // once when the Session is already idle), so the message is never lost.
      const activeTurnId = get().execution.activeTurnId
      let queueAdmission = mode === "queue"
      if (
        activeTurnId !== undefined &&
        text !== COMPACT_DIRECTIVE &&
        !queueAdmission
      ) {
        let rejected = false
        const requestId = createRequestId()
        inFlightSteerRequests.add(requestId)
        await runTask(
          async () => {
            let reserved = false
            let promotedContent: InputContent | undefined
            try {
              inputRecoveryMemory.reserveSteer(
                get().apiBase,
                selection.sessionId,
                {
                  requestId,
                  turnId: activeTurnId,
                  content,
                  restored: false,
                },
              )
              reserved = true
              const response = await getAppRpcClient(get().apiBase).request(
                "session/input/steer",
                {
                  sessionId: selection.sessionId,
                  requestId,
                  expectedTurnId: activeTurnId,
                  content,
                },
              )
              if (
                response.turnId !== activeTurnId ||
                response.requestId !== requestId
              ) {
                throw new Error("Steer response did not match the request.")
              }
              promotedContent = response.content
            } catch (error) {
              inFlightSteerRequests.delete(requestId)
              committedSteerRequests.delete(requestId)
              if (reserved)
                inputRecoveryMemory.updateSteers(
                  get().apiBase,
                  selection.sessionId,
                  (steers) =>
                    steers.filter((steer) => steer.requestId !== requestId),
                )
              if (
                error instanceof ApiRequestError &&
                error.code === "conflict"
              ) {
                rejected = true
                queueAdmission = true
                return
              }
              throw error
            }
            // Acceptance is ephemeral until input.admitted commits. Keep ownership
            // across navigation and reconnect so an interrupted Turn can restore it.
            const committed =
              committedSteerRequests.has(requestId) ||
              (isCurrentSelection(selection) &&
                get().execution.admittedRequestIds[requestId] === true)
            inFlightSteerRequests.delete(requestId)
            committedSteerRequests.delete(requestId)
            const acceptedContent = promotedContent
            if (acceptedContent !== undefined) {
              recordPromotedContent(content, acceptedContent)
              inputRecoveryMemory.updateSteers(
                get().apiBase,
                selection.sessionId,
                (steers) =>
                  steers.map((steer) =>
                    steer.requestId === requestId
                      ? { ...steer, content: acceptedContent }
                      : steer,
                  ),
              )
              set((state) => ({
                pendingSteers: {
                  ...state.pendingSteers,
                  [selection.sessionId]: (
                    state.pendingSteers[selection.sessionId] ?? []
                  ).map((steer) =>
                    steer.requestId === requestId
                      ? { ...steer, content: acceptedContent }
                      : steer,
                  ),
                },
              }))
            }
            const alreadyRestored =
              get().restoredSteerRequestIds[requestId] === true
            if (
              !committed &&
              !alreadyRestored &&
              !(get().pendingSteers[selection.sessionId] ?? []).some(
                (steer) => steer.requestId === requestId,
              )
            ) {
              set((state) => ({
                pendingSteers: {
                  ...state.pendingSteers,
                  [selection.sessionId]: [
                    ...(state.pendingSteers[selection.sessionId] ?? []),
                    {
                      requestId,
                      turnId: activeTurnId,
                      content: acceptedContent ?? content,
                      restored: false,
                    },
                  ],
                },
              }))
            }
            if (alreadyRestored && acceptedContent !== undefined) {
              const acceptedAttachments =
                inputContentAttachments(acceptedContent)
              const replaceParts = (current: InputDraft): InputDraft => ({
                ...current,
                attachments: current.attachments.map((attachment) => {
                  const index = attachments.findIndex((original) =>
                    sameAttachments([original], [attachment]),
                  )
                  return acceptedAttachments[index] ?? attachment
                }),
              })
              set((state) =>
                state.selection.sessionId === selection.sessionId
                  ? {
                      promptDraft: replaceParts(
                        state.promptDraft ?? textInputDraft(""),
                      ),
                    }
                  : {
                      sessionDrafts: {
                        ...state.sessionDrafts,
                        [selection.sessionId]: {
                          ...(state.sessionDrafts[selection.sessionId] ?? {
                            content: undefined,
                            excerpts: [],
                          }),
                          content: replaceParts(
                            state.sessionDrafts[selection.sessionId]?.content ??
                              textInputDraft(""),
                          ),
                        },
                      },
                    },
              )
            }

            if (!alreadyRestored) retireRestoredSteers(selection.sessionId)
            if (!isCurrentSelection(selection)) {
              if (alreadyRestored) return
              set((state) => {
                if (state.selection.sessionId === selection.sessionId) {
                  const clear = sameResolvedDraft(
                    trimInputDraft(state.promptDraft ?? textInputDraft("")),
                    parts,
                  )
                  return {
                    promptDraft: clear ? undefined : state.promptDraft,
                    promptExcerpts: state.promptExcerpts.filter(
                      (excerpt) => !excerpts.includes(excerpt),
                    ),
                  }
                }
                const draft = state.sessionDrafts[selection.sessionId]
                if (draft === undefined) return state
                const clear = sameResolvedDraft(
                  trimInputDraft(draft.content ?? textInputDraft("")),
                  parts,
                )
                return {
                  sessionDrafts: {
                    ...state.sessionDrafts,
                    [selection.sessionId]: {
                      ...draft,
                      content: clear ? undefined : draft.content,
                      excerpts: draft.excerpts.filter(
                        (excerpt) => !excerpts.includes(excerpt),
                      ),
                    },
                  },
                }
              })
              if (
                authoritativeTurns.has(selection.sessionId) &&
                authoritativeTurns.get(selection.sessionId) !== activeTurnId
              )
                restoreUncommittedSteers(selection.sessionId, activeTurnId)
              return
            }
            set((state) => ({
              promptExcerpts: state.promptExcerpts.filter(
                (excerpt) => !excerpts.includes(excerpt),
              ),
            }))
            if (
              !alreadyRestored &&
              sameResolvedDraft(
                trimInputDraft(get().promptDraft ?? textInputDraft("")),
                parts,
              )
            ) {
              set({ promptDraft: undefined })
            }
            if (
              get().execution.turnTimings[activeTurnId]?.completedAt !==
                undefined ||
              (authoritativeTurns.has(selection.sessionId) &&
                authoritativeTurns.get(selection.sessionId) !== activeTurnId)
            ) {
              restoreUncommittedSteers(selection.sessionId, activeTurnId)
            }
          },
          () => isCurrentSelection(selection),
        )
        if (!rejected) {
          set((state) => {
            const inFlightActions = new Set(state.inFlightActions)
            inFlightActions.delete(key)
            return { inFlightActions }
          })
          return
        }
      }

      // The compact directive takes a dedicated lane: no input recovery,
      // no model selection — the server admits it as a runtime-role Input.
      // A per-invocation requestId keeps a retried call from admitting a
      // duplicate compact directive.
      if (text === COMPACT_DIRECTIVE) {
        await runTask(
          async () => {
            const requestId = createRequestId()
            const response = await getAppRpcClient(get().apiBase).request(
              "session/compact",
              {
                sessionId: selection.sessionId,
                requestId,
              },
            )
            if (response.requestId !== requestId) {
              throw new Error("Compact response did not match the request.")
            }
            if (!isCurrentSelection(selection)) return
            if (
              sameResolvedDraft(
                trimInputDraft(get().promptDraft ?? textInputDraft("")),
                parts,
              )
            ) {
              set({ promptDraft: undefined })
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
          const admittedModelSelection = queuedForCreation
            ? queuedModelSelection
            : normalizeKimiModelSelection(modelSelection, state.providers)
          const pendingAdmission = inputRecoveryMemory.reserveAdmission({
            apiBase: get().apiBase,
            sessionId: selection.sessionId,
            content,
            ...(admittedModelSelection === undefined
              ? {}
              : { modelSelection: admittedModelSelection }),
            ...(firstInputAdmission === undefined
              ? {}
              : { supersedesRequestId: firstInputAdmission.requestId }),
          })
          inFlightAdmissions.add(pendingAdmission.requestId)
          let response: ApiAdmitInputResponse
          try {
            if (firstInputAdmission !== undefined) {
              inputRecoveryMemory.acknowledgeAdmission(firstInputAdmission)
              set({ recoveredAdmission: undefined })
            }
            if (!isCurrentSelection(selection)) return
            // Equivalent retries retain the original payload's nested key order.
            response = await getAppRpcClient(get().apiBase).request(
              queueAdmission ? "session/input/queue" : "session/input",
              {
                sessionId: selection.sessionId,
                requestId: pendingAdmission.requestId,
                content: pendingAdmission.content,
                ...(pendingAdmission.modelSelection === undefined
                  ? {}
                  : { modelSelection: pendingAdmission.modelSelection }),
              },
            )
          } finally {
            inFlightAdmissions.delete(pendingAdmission.requestId)
          }
          if (response.requestId !== pendingAdmission.requestId) {
            throw new Error("Admission response did not match the request.")
          }
          recordPromotedContent(pendingAdmission.content, response.content)
          if (rejectedAdmissions.delete(pendingAdmission.requestId)) return
          retireRestoredSteers(selection.sessionId)
          // Queue storage has committed before its response. Direct starts
          // still wait for input.admitted from the rollout stream.
          if (
            queueAdmission ||
            get().execution.admittedRequestIds[pendingAdmission.requestId]
          ) {
            inputRecoveryMemory.acknowledgeAdmission(pendingAdmission)
          }
          if (!isCurrentSelection(selection)) return
          set((state) => ({
            // A new or edited excerpt queued during admission belongs to the
            // next input. Immutable snapshots identify only what was sent.
            promptExcerpts: state.promptExcerpts.filter(
              (excerpt) => !excerpts.includes(excerpt),
            ),
          }))
          if (
            sameResolvedDraft(
              trimInputDraft(get().promptDraft ?? textInputDraft("")),
              parts,
            )
          ) {
            set({
              promptDraft: undefined,
            })
          }
          set((state) => {
            const inFlightActions = new Set(state.inFlightActions)
            inFlightActions.delete(key)
            return { inFlightActions }
          })
          if (!isCurrentSelection(selection)) return
          if (queueAdmission) await get().refreshQueuedInputs()
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

    refreshQueuedInputs: async () => {
      const selection = currentSelection()
      if (!selection) return
      const revision = ++queueReadRevision
      try {
        const { items } = await getAppRpcClient(get().apiBase).request(
          "session/queue/list",
          { sessionId: selection.sessionId },
        )
        if (!isCurrentSelection(selection) || revision !== queueReadRevision)
          return
        const pendingInputs = items.map((item) => ({
          id: item.id,
          text: inputContentText(item.input.content),
          admittedAt: item.createdAt,
        }))
        set((state) => ({
          queuedItems: items,
          execution: {
            ...state.execution,
            queuedInputs: Object.fromEntries(
              pendingInputs.map((item) => [item.id, item]),
            ),
          },
        }))
        for (const item of items) {
          const admission = inputRecoveryMemory.readAdmissionByRequestId(
            get().apiBase,
            selection.sessionId,
            item.input.submissionId,
          )
          if (admission === undefined) continue
          recordPromotedContent(admission.content, item.input.content)
          inputRecoveryMemory.acknowledgeAdmission(admission)
        }
      } catch (error) {
        if (isCurrentSelection(selection))
          set({ message: errorMessage(error, "Could not load queued inputs.") })
      }
    },

    updateQueuedInput: async (inputId, parts) => {
      const selection = currentSelection()
      if (!selection) return
      const item = get().queuedItems.find((entry) => entry.id === inputId)
      if (item === undefined) return
      const requestId = createRequestId()
      await runTask(
        async () => {
          await getAppRpcClient(get().apiBase).request("session/queue/update", {
            sessionId: selection.sessionId,
            inputId,
            requestId,
            content: inputContent(parts, item.input.content.references),
            ...(item.input.modelSelection === undefined
              ? {}
              : { modelSelection: item.input.modelSelection }),
          })
          await get().refreshQueuedInputs()
        },
        () => isCurrentSelection(selection),
      )
    },

    reorderQueuedInputs: async (inputIds) => {
      const selection = currentSelection()
      if (!selection) return
      await runTask(
        async () => {
          await getAppRpcClient(get().apiBase).request(
            "session/queue/reorder",
            {
              sessionId: selection.sessionId,
              inputIds,
            },
          )
          await get().refreshQueuedInputs()
        },
        () => isCurrentSelection(selection),
      )
    },

    startQueuedInput: async (inputId) => {
      const selection = currentSelection()
      if (!selection) return
      await runTask(
        async () => {
          await getAppRpcClient(get().apiBase).request("session/queue/start", {
            sessionId: selection.sessionId,
            inputId,
          })
          await get().refreshQueuedInputs()
        },
        () => isCurrentSelection(selection),
      )
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
            await get().refreshQueuedInputs()
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

    setPromptDraft: (parts) => {
      set({ promptDraft: parts })
    },
    addPromptExcerpt: (excerpt) => {
      set((state) => ({
        promptExcerpts: [
          ...state.promptExcerpts,
          { ...excerpt, source: { ...excerpt.source } },
        ],
        composerFocusRevision: state.composerFocusRevision + 1,
      }))
    },

    removePromptExcerpt: (id) => {
      set((state) => ({
        promptExcerpts: state.promptExcerpts.filter(
          (excerpt) => excerpt.id !== id,
        ),
      }))
    },

    updatePromptExcerpt: (excerpt) => {
      set((state) => ({
        promptExcerpts: state.promptExcerpts.map((current) =>
          current.id === excerpt.id
            ? { ...excerpt, source: { ...excerpt.source } }
            : current,
        ),
      }))
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

    openSettings: (section = "general") => {
      set({ settingsSection: section })
      if (section === "subscriptions" && !get().subscriptionsFresh())
        void get().loadSubscriptions()
      if (section === "usage") void get().loadUsage()
    },
    closeSettings: () => set({ settingsSection: undefined }),
    setSettingsSection: (section) => {
      set({ settingsSection: section })
      if (section === "subscriptions" && !get().subscriptionsFresh())
        void get().loadSubscriptions()
      if (section === "usage") void get().loadUsage()
    },
    openGoalDialog: () =>
      set((state) => ({ goalDialogRevision: state.goalDialogRevision + 1 })),
    setGoal: async (input) => {
      const apiBase = get().apiBase
      const goalAtRequest = goalSnapshots.get(input.sessionId)
      const key = `goal:${input.sessionId}`
      if (get().inFlightActions.has(key)) return false
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      const completed = await runTask(
        async () => {
          const response = await getAppRpcClient(apiBase).request(
            "goal/set",
            input,
          )
          if (
            get().apiBase !== apiBase ||
            goalSnapshots.get(input.sessionId) !== goalAtRequest
          )
            return
          goalSnapshots.set(input.sessionId, { goal: response.goal })
          set((state) => projectGoal(state, input.sessionId, response.goal))
        },
        () => get().apiBase === apiBase,
        false,
        false,
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
      return completed
    },
    clearGoal: async (sessionId) => {
      const apiBase = get().apiBase
      const goalAtRequest = goalSnapshots.get(sessionId)
      const key = `goal:${sessionId}`
      if (get().inFlightActions.has(key)) return false
      set((state) => ({
        inFlightActions: new Set(state.inFlightActions).add(key),
      }))
      const completed = await runTask(
        async () => {
          const response = await getAppRpcClient(apiBase).request(
            "goal/clear",
            { sessionId },
          )
          if (
            get().apiBase !== apiBase ||
            goalSnapshots.get(sessionId) !== goalAtRequest
          )
            return
          goalSnapshots.set(sessionId, { goal: response.goal })
          set((state) => projectGoal(state, sessionId, response.goal))
        },
        () => get().apiBase === apiBase,
        false,
        false,
      )
      set((state) => {
        const inFlightActions = new Set(state.inFlightActions)
        inFlightActions.delete(key)
        return { inFlightActions }
      })
      return completed
    },
    openModelPicker: () =>
      set((state) => ({
        modelPickerRevision: state.modelPickerRevision + 1,
      })),
    openRenameDialog: () =>
      set((state) => ({
        renameDialogRevision: state.renameDialogRevision + 1,
      })),
    openCommandPanel: (kind) =>
      set({
        commandPanel: {
          ...(get().selection.sessionId === undefined
            ? {}
            : { sessionId: get().selection.sessionId }),
          kind,
        },
      }),
    closeCommandPanel: () => set({ commandPanel: undefined }),
    subscriptionsFresh: () => {
      const states = get().subscriptionsByProvider
      return (["codex", "grok", "kimi"] as const).every((provider) => {
        const state = states[provider]
        return (
          (state.subscription !== undefined || state.error !== undefined) &&
          state.updatedAt !== undefined &&
          Date.now() - state.updatedAt < 30_000
        )
      })
    },
    loadUsage: async () => {
      const apiBase = get().apiBase
      set((state) => ({
        usage: {
          ...(state.usage.summary === undefined
            ? {}
            : { summary: state.usage.summary }),
          loading: true,
        },
      }))
      try {
        const response = await getAppRpcClient(apiBase).request(
          "usage/read",
          {},
        )
        if (apiBase !== get().apiBase) return
        set({ usage: { summary: response.usage, loading: false } })
      } catch (error) {
        if (apiBase !== get().apiBase) return
        set((state) => ({
          usage: {
            ...(state.usage.summary === undefined
              ? {}
              : { summary: state.usage.summary }),
            loading: false,
            error: errorMessage(error, "Usage could not be loaded."),
          },
        }))
      }
    },
  }
})

function replaceProject(
  projects: readonly ApiProject[],
  updated: ApiProject,
): ApiProject[] {
  return projects
    .map((project) => (project.id === updated.id ? updated : project))
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        left.position - right.position,
    )
}

function optimisticPinnedSidebar(
  state: AppStoreData,
  change: Readonly<{ sessionId: string; sectionId: string | null }>,
): SessionSidebar | undefined {
  const session = findCachedSession(state, change.sessionId)
  if (session === undefined) return
  const navigationId = session.navigationId ?? session.id
  const entry = { ...state.sidebar.entries[navigationId] }
  if (change.sectionId === null) {
    delete entry.sectionId
    delete entry.sectionPosition
  } else if (entry.sectionId !== change.sectionId) {
    entry.sectionId = change.sectionId
    entry.sectionPosition =
      Math.max(
        0,
        ...Object.values(state.sidebar.entries)
          .filter((candidate) => candidate.sectionId === change.sectionId)
          .map((candidate) => candidate.sectionPosition ?? 0),
      ) + 1_000_000
  }
  return {
    ...state.sidebar,
    entries: {
      ...state.sidebar.entries,
      [navigationId]: entry,
    },
  }
}

function restoreSidebarSection(
  current: SessionSidebar,
  previous: SessionSidebar,
  navigationId: string,
): SessionSidebar {
  const entries = { ...current.entries }
  const entry = { ...entries[navigationId] }
  const previousEntry = previous.entries[navigationId]
  if (previousEntry?.sectionId === undefined) delete entry.sectionId
  else entry.sectionId = previousEntry.sectionId
  if (previousEntry?.sectionPosition === undefined) delete entry.sectionPosition
  else entry.sectionPosition = previousEntry.sectionPosition
  if (Object.keys(entry).length === 0) delete entries[navigationId]
  else entries[navigationId] = entry
  return { ...current, entries }
}

function projectSidebarSession(
  state: AppStoreData,
  sidebar: SessionSidebar,
  sessionId: string,
  cachedSession?: ApiSessionSummary,
): Partial<AppStoreData> {
  const session = findCachedSession(state, sessionId) ?? cachedSession
  if (session === undefined) return { sidebar }
  const navigationId = session.navigationId ?? session.id
  const projected = withSidebarPresentation(session, sidebar)
  const sessionsByProject = Object.fromEntries(
    Object.entries(state.sessionsByProject).map(([key, list]) => {
      const sessions = list.sessions
        .filter(
          (candidate) =>
            (candidate.navigationId ?? candidate.id) !== navigationId,
        )
        .map((candidate) => withSidebarPresentation(candidate, sidebar))
      // The opaque cursor describes the pre-mutation row, so keep that
      // presentation as the page boundary instead of reprojecting it.
      const anchor = list.sessions.at(-1)
      if (
        sessionMatchesList(projected, key) &&
        (list.nextCursor === undefined ||
          anchor === undefined ||
          compareSidebarSessions(key, projected, anchor) <= 0)
      ) {
        sessions.push(projected)
      }
      sessions.sort((left, right) => compareSidebarSessions(key, left, right))
      const { loading: _loading, ...settled } = list
      return [key, { ...settled, sessions }]
    }),
  )
  const selectedSession =
    state.selectedSession !== undefined &&
    (state.selectedSession.navigationId ?? state.selectedSession.id) ===
      navigationId
      ? withSidebarPresentation(state.selectedSession, sidebar)
      : state.selectedSession
  return { sidebar, sessionsByProject, selectedSession }
}

function findCachedSession(
  state: AppStoreData,
  sessionId: string,
): ApiSessionSummary | undefined {
  for (const list of Object.values(state.sessionsByProject)) {
    const session = list.sessions.find(
      (candidate) => candidate.id === sessionId,
    )
    if (session !== undefined) return session
  }
  return state.selectedSession?.id === sessionId
    ? state.selectedSession
    : undefined
}

function withSidebarPresentation<T extends ApiSessionSummary>(
  session: T,
  sidebar: SessionSidebar,
): T {
  const {
    archived: _archived,
    sectionId: _sectionId,
    sectionPosition: _sectionPosition,
    ...base
  } = session
  return {
    ...base,
    ...sidebar.entries[session.navigationId ?? session.id],
  } as T
}

function projectGoal(
  state: AppStoreData,
  sessionId: string,
  goal: ThreadGoal | null,
): Pick<AppStoreData, "selectedSession" | "sessionsByProject"> {
  const update = <T extends ApiSessionSummary>(session: T): T => {
    if (session.id !== sessionId) return session
    return withGoal(session, goal)
  }
  return {
    selectedSession:
      state.selectedSession === undefined
        ? undefined
        : update(state.selectedSession),
    sessionsByProject: Object.fromEntries(
      Object.entries(state.sessionsByProject).map(([key, list]) => [
        key,
        { ...list, sessions: list.sessions.map(update) },
      ]),
    ),
  }
}

function withGoal<T extends ApiSessionSummary>(
  session: T,
  goal: ThreadGoal | null,
): T {
  const { goal: _goal, ...base } = session
  return { ...base, ...(goal === null ? {} : { goal }) } as T
}

function sessionMatchesList(session: ApiSessionSummary, key: string): boolean {
  if (key === "sidebar:archived") return session.archived === true
  if (session.archived === true) return false
  if (key.startsWith("sidebar:section:")) {
    return session.sectionId === key.slice("sidebar:section:".length)
  }
  if (key === allSessionsListKey) return true
  return session.projectId === key && session.sectionId === undefined
}

function compareSidebarSessions(
  key: string,
  left: Pick<
    ApiSessionSummary,
    "id" | "navigationId" | "sectionPosition" | "updatedAt"
  >,
  right: Pick<
    ApiSessionSummary,
    "id" | "navigationId" | "sectionPosition" | "updatedAt"
  >,
): number {
  if (key.startsWith("sidebar:section:")) {
    const position =
      (left.sectionPosition ?? Number.MAX_SAFE_INTEGER) -
      (right.sectionPosition ?? Number.MAX_SAFE_INTEGER)
    if (position !== 0) return position
    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      (right.navigationId ?? right.id).localeCompare(
        left.navigationId ?? left.id,
      )
    )
  }
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id)
  )
}

export function resolveEffectiveModel(input: {
  readonly sessionCurrent: ModelSelection | undefined
  readonly userPreference: ApiUserModelPreference | undefined
  readonly defaultProvider: string | undefined
  readonly defaultModel: string | undefined
  readonly providers: readonly ApiProviderSummary[]
}): ModelSelection | undefined {
  // A ChatGPT selection names a billing/account boundary. Losing its grant or
  // catalog must never silently send the next input through another provider.
  if (
    input.sessionCurrent?.provider.startsWith("chatgpt-") ||
    isAvailableModel(input.sessionCurrent, input.providers)
  ) {
    return input.sessionCurrent
  }
  if (
    input.userPreference?.provider.startsWith("chatgpt-") ||
    isAvailableModel(input.userPreference, input.providers)
  ) {
    return input.userPreference
  }
  if (input.defaultProvider === undefined || input.defaultModel === undefined) {
    return undefined
  }
  const fallback = {
    provider: input.defaultProvider,
    model: input.defaultModel,
  }
  return fallback.provider.startsWith("chatgpt-") ||
    isAvailableModel(fallback, input.providers)
    ? fallback
    : undefined
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

  const next: ApiSessionDetail = {
    ...session,
    seq: event.seq,
    updatedAt: event.createdAt,
  }
  switch (event.type) {
    case "input.admitted":
      return {
        ...next,
        counts: { ...session.counts, inputs: session.counts.inputs + 1 },
      }
    case "turn.started":
      return {
        ...next,
        activeTurnId: event.data.turnId,
      }
    case "turn.completed": {
      const { activeTurnId: _, ...withoutActiveTurn } = next
      return withoutActiveTurn
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
  const queryApi = new URLSearchParams(globalThis.location.search).get("api")
  if (queryApi) return queryApi
  return globalThis.location.origin
}

function stashSessionDraft(state: AppStoreData): Record<string, SessionDraft> {
  const sessionId = state.selection.sessionId
  if (sessionId === undefined) return state.sessionDrafts
  const hasContent =
    hasInputDraft(trimInputDraft(state.promptDraft ?? textInputDraft(""))) ||
    state.promptExcerpts.length > 0
  const sessionDrafts = { ...state.sessionDrafts }
  if (hasContent) {
    sessionDrafts[sessionId] = {
      content: state.promptDraft,
      excerpts: state.promptExcerpts,
    }
  } else {
    delete sessionDrafts[sessionId]
  }
  return sessionDrafts
}

function takeSessionDraft(
  sessionDrafts: Record<string, SessionDraft>,
  sessionId: string,
): Pick<AppStoreData, "sessionDrafts" | "promptDraft" | "promptExcerpts"> {
  const next = { ...sessionDrafts }
  const draft = next[sessionId]
  delete next[sessionId]
  return {
    sessionDrafts: next,
    promptDraft: draft?.content,
    promptExcerpts: draft?.excerpts ?? [],
  }
}

function sameAttachments(
  left: readonly UserAttachment[],
  right: readonly UserAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        attachment.name === other.name &&
        attachment.mediaType === right[index]?.mediaType &&
        attachment.sizeBytes === right[index]?.sizeBytes &&
        ("detail" in attachment ? attachment.detail : undefined) ===
          ("detail" in (right[index] ?? {})
            ? (right[index] as { detail?: string }).detail
            : undefined) &&
        right[index] !== undefined &&
        assetSourceKey(attachment.file) === assetSourceKey(other.file)
      )
    })
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
  const raw = globalThis.localStorage.getItem("yakitori.modelSelections")
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
  globalThis.localStorage.setItem(
    "yakitori.modelSelections",
    JSON.stringify(modelSelections),
  )
}

function initialCollapsedProjects(): Record<string, boolean> {
  const raw = globalThis.localStorage.getItem("yakitori.collapsedProjects")
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
  globalThis.localStorage.setItem(
    "yakitori.collapsedProjects",
    JSON.stringify(collapsedProjects),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}
