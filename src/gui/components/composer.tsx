import { useCallback, useContext, useRef, useState } from "react"
import { GOAL_DIRECTIVE } from "../../kernel/events.ts"
import {
  discardDraftImages,
  requireDesktopBridge,
} from "../composer-attachments.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
import { usePreferencesStore } from "../store/preferences-store.ts"
import {
  type ComposerImageImport,
  ComposerSurface,
} from "./composer-surface.tsx"
import { ModelSelector } from "./model-selector.tsx"

export function Composer() {
  const conversationScroll = useContext(ConversationScrollContext)
  const draft = useAppStore((state) => state.promptDraft) ?? ""
  const attachments = useAppStore((state) => state.promptAttachments)
  const excerpts = useAppStore((state) => state.promptExcerpts)
  const removePromptExcerpt = useAppStore((state) => state.removePromptExcerpt)
  const updatePromptExcerpt = useAppStore((state) => state.updatePromptExcerpt)
  const sessionSkillsError = useAppStore((state) => state.sessionSkillsError)
  const sessionSkills = useAppStore((state) => state.sessionSkills)
  const apiBase = useAppStore((state) => state.apiBase)
  const busy = useAppStore((state) => state.busy)
  const focusRevision = useAppStore((state) => state.composerFocusRevision)
  const restoringModelSelectionFor = useAppStore(
    (state) => state.restoringModelSelectionFor,
  )
  const providers = useAppStore((state) => state.providers)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const userPreference = useAppStore((state) => state.userPreference)
  const inFlightActions = useAppStore((state) => state.inFlightActions)
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut)
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const selectionRevision = useAppStore(
    (state) => state.sessionSelectionIntentRevision,
  )
  const sessionCurrent = useAppStore((state) =>
    state.selection.sessionId === undefined
      ? state.draftModelSelection
      : state.modelSelections[state.selection.sessionId],
  )
  const setPromptDraft = useAppStore((state) => state.setPromptDraft)
  const setPromptAttachments = useAppStore(
    (state) => state.setPromptAttachments,
  )
  const admitInput = useAppStore((state) => state.admitInput)
  const cancelTurn = useAppStore((state) => state.cancelTurn)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const openGoalDialog = useAppStore((state) => state.openGoalDialog)
  const view = useExecutionView()
  const [attachmentError, setAttachmentError] = useState<string>()
  const [readingImages, setReadingImages] = useState(false)
  const fileSearchCwd = useAppStore(
    (state) =>
      state.selectedSession?.workingDirectory ??
      state.projects.find((project) => project.id === state.currentProject)
        ?.roots[0],
  )
  // The @-mention picker fetches the workspace index once per directory and
  // filters it locally; rescanning ripgrep per keystroke is slow enough on
  // large repos that the picker could return nothing at all.
  const fileIndexes = useRef(new Map<string, Promise<readonly string[]>>())
  const searchFiles = useCallback(
    async (query: string) => {
      if (fileSearchCwd === undefined) return []
      const key = `${apiBase}${fileSearchCwd}`
      let index = fileIndexes.current.get(key)
      if (index === undefined) {
        index = getAppRpcClient(apiBase)
          .request("workspace/findFiles", {
            cwd: fileSearchCwd,
            query: "",
            limit: 20_000,
          })
          .then((response) => response.paths)
        fileIndexes.current.set(key, index)
        index.catch(() => fileIndexes.current.delete(key))
      }
      return rankFileMatches(await index, query, 20).map((path) => ({
        name: path.split("/").at(-1) ?? path,
        path,
      }))
    },
    [fileSearchCwd, apiBase],
  )
  const effectiveModel = normalizeKimiModelSelection(
    resolveEffectiveModel({
      sessionCurrent,
      userPreference,
      defaultProvider,
      defaultModel,
      providers,
    }),
    providers,
  )
  const modelEntry = providers
    .find((provider) => provider.name === effectiveModel?.provider)
    ?.models.find((model) => model.id === effectiveModel?.model)
  const supportsImages =
    modelEntry === undefined
      ? true
      : (modelEntry.inputModalities?.includes("image") ?? false)
  const supportsOriginal =
    modelEntry === undefined
      ? true
      : (modelEntry.imageDetailModes?.includes("original") ?? false)

  const importImages: ComposerImageImport = async (prepare, validate) => {
    if (readingImages) return
    setReadingImages(true)
    setAttachmentError(undefined)
    let importSessionId = sessionId
    const importIntentRevision =
      useAppStore.getState().sessionSelectionIntentRevision
    let cleanup: (() => Promise<void>) | undefined
    try {
      // Reject unusable files before a lazy createSession can litter an
      // empty session.
      validate?.()
      requireDesktopBridge()
      const prepared = await prepare()
      if (prepared === undefined) return
      cleanup = prepared.cleanup
      const currentSessionId = useAppStore.getState().selection.sessionId
      if (importSessionId === undefined) importSessionId = currentSessionId
      const next = await prepared.collect(importSessionId)
      const current = useAppStore.getState()
      if (
        current.sessionSelectionIntentRevision !== importIntentRevision ||
        (current.selection.sessionId !== currentSessionId &&
          !(
            sessionId === undefined &&
            currentSessionId === undefined &&
            current.selection.sessionId !== undefined
          ))
      ) {
        await discardDraftImages(next.slice(attachments.length))
        return
      }
      setPromptAttachments(next)
    } catch (error) {
      const current = useAppStore.getState()
      const stillSelected =
        current.selection.sessionId === sessionId &&
        current.sessionSelectionIntentRevision === importIntentRevision
      if (stillSelected) {
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "Images could not be attached.",
        )
      }
    } finally {
      if (cleanup !== undefined) {
        try {
          await cleanup()
        } catch (error) {
          setAttachmentError(
            error instanceof Error
              ? error.message
              : "Image selection could not be released.",
          )
        }
      }
      setReadingImages(false)
    }
  }

  const activeTurnId = view.activeTurnId
  return (
    <ComposerSurface
      sessionId={sessionId}
      draft={draft}
      attachments={attachments}
      excerpts={excerpts}
      sessionSkills={sessionSkills}
      sessionSkillsError={sessionSkillsError}
      apiBase={apiBase}
      focusRevision={focusRevision}
      busy={
        busy ||
        (sessionId !== undefined && restoringModelSelectionFor === sessionId)
      }
      sending={
        sessionId === undefined
          ? inFlightActions.has(`queue-first-input:${selectionRevision}`)
          : inFlightActions.has(`admit:${sessionId}`)
      }
      stopping={
        activeTurnId !== undefined &&
        inFlightActions.has(`cancel:${activeTurnId}`)
      }
      activeTurnId={activeTurnId}
      supportsImages={supportsImages}
      supportsOriginal={supportsOriginal}
      historyTexts={view.entries.flatMap((entry) =>
        entry.kind === "user_input" ? [entry.text] : [],
      )}
      setPromptDraft={setPromptDraft}
      setPromptAttachments={setPromptAttachments}
      removePromptExcerpt={removePromptExcerpt}
      updatePromptExcerpt={updatePromptExcerpt}
      onSubmit={(text, images, mode) => {
        conversationScroll?.jumpToBottom()
        const goalCommand =
          text === GOAL_DIRECTIVE
            ? ""
            : text.startsWith(`${GOAL_DIRECTIVE} `)
              ? text.slice(GOAL_DIRECTIVE.length + 1).trim()
              : undefined
        if (goalCommand !== undefined) {
          if (sessionId === undefined) {
            useAppStore.setState({
              message:
                "Goals attach to a conversation. Send a message first, then set the goal.",
            })
            return
          }
          setPromptDraft("")
          if (goalCommand === "") openGoalDialog()
          else
            void changeSidebar({
              type: "session",
              sessionId,
              goal: goalCommand,
            })
          return
        }
        if (mode === "queue") {
          void admitInput(text, images, "queue")
        } else if (images.length === 0) {
          void admitInput(text)
        } else {
          void admitInput(text, images)
        }
      }}
      onCancel={() => {
        if (activeTurnId) void cancelTurn(activeTurnId)
      }}
      modelControls={<ModelSelector />}
      importImages={importImages}
      readingImages={readingImages}
      attachmentError={attachmentError}
      onAttachmentError={setAttachmentError}
      searchFiles={searchFiles}
      placeholder={
        sessionId === undefined
          ? "Describe what you want to work on"
          : activeTurnId !== undefined
            ? sendShortcut === "enter"
              ? "Steer this turn · ⌘ / Ctrl + Enter queues for the next"
              : "⌘ / Ctrl + Enter steers · Shift + ⌘ / Ctrl + Enter queues"
            : "Ask anything"
      }
    />
  )
}

function rankFileMatches(
  index: readonly string[],
  query: string,
  limit: number,
): string[] {
  const needle = query.toLowerCase()
  return index
    .flatMap((path) => {
      if (needle.length === 0) return [{ path, rank: 1 }]
      const name = path.split("/").at(-1) ?? path
      if (name.toLowerCase().includes(needle)) return [{ path, rank: 0 }]
      return path.toLowerCase().includes(needle) ? [{ path, rank: 1 }] : []
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path),
    )
    .slice(0, limit)
    .map((entry) => entry.path)
}
