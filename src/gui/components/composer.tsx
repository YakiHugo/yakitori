import { useContext, useState } from "react"
import {
  discardDraftImages,
  requireDesktopBridge,
} from "../composer-attachments.ts"
import { ConversationScrollContext } from "../hooks/conversation-scroll-context.ts"
import {
  normalizeKimiModelSelection,
  resolveEffectiveModel,
  useAppStore,
  useExecutionView,
} from "../store/app-store.ts"
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
  const sessionId = useAppStore((state) => state.selection.sessionId)
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
  const view = useExecutionView()
  const [attachmentError, setAttachmentError] = useState<string>()
  const [readingImages, setReadingImages] = useState(false)
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
    let importSelectionRevision = importIntentRevision
    let createdSessionId: string | undefined
    let draftBeforeCreate: string | undefined
    let cleanup: (() => Promise<void>) | undefined
    try {
      // Reject unusable files before a lazy createSession can litter an
      // empty session.
      validate?.()
      requireDesktopBridge()
      const prepared = await prepare()
      if (prepared === undefined) return
      cleanup = prepared.cleanup
      if (importSessionId === undefined) {
        let current = useAppStore.getState()
        if (current.sessionSelectionIntentRevision !== importIntentRevision)
          return
        importSessionId = current.selection.sessionId
        if (
          importSessionId === undefined &&
          current.inFlightActions.has("create-session")
        ) {
          await waitForAction("create-session")
          current = useAppStore.getState()
          if (current.sessionSelectionIntentRevision !== importIntentRevision)
            return
          importSessionId = current.selection.sessionId
        }
      }
      if (importSessionId === undefined) {
        draftBeforeCreate = useAppStore.getState().promptDraft
        importSessionId = await useAppStore.getState().createSession()
        if (importSessionId === undefined) return
        createdSessionId = importSessionId
        importSelectionRevision =
          useAppStore.getState().sessionSelectionIntentRevision
      }
      const next = await prepared.collect(importSessionId)
      const current = useAppStore.getState()
      if (
        current.selection.sessionId !== importSessionId ||
        current.sessionSelectionIntentRevision !== importSelectionRevision
      ) {
        await discardDraftImages(next.slice(attachments.length))
        return
      }
      setPromptAttachments(next)
    } catch (error) {
      const current = useAppStore.getState()
      const stillSelected =
        current.selection.sessionId === importSessionId &&
        current.sessionSelectionIntentRevision === importSelectionRevision
      if (createdSessionId !== undefined && stillSelected) {
        await current.deleteSession(createdSessionId)
        if (draftBeforeCreate !== undefined) {
          useAppStore.getState().setPromptDraft(draftBeforeCreate)
        }
      }
      if (stillSelected || createdSessionId !== undefined) {
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
        sessionId !== undefined && inFlightActions.has(`admit:${sessionId}`)
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
      onSubmit={(text, images) => {
        conversationScroll?.jumpToBottom()
        if (images.length === 0) void admitInput(text)
        else void admitInput(text, images)
      }}
      onCancel={() => {
        if (activeTurnId) void cancelTurn(activeTurnId)
      }}
      modelControls={<ModelSelector />}
      importImages={importImages}
      readingImages={readingImages}
      attachmentError={attachmentError}
      onAttachmentError={setAttachmentError}
      placeholder={
        sessionId === undefined
          ? "Describe what you want to work on"
          : "Ask anything"
      }
    />
  )
}

function waitForAction(key: string): Promise<void> {
  if (!useAppStore.getState().inFlightActions.has(key)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.inFlightActions.has(key)) return
      unsubscribe()
      resolve()
    })
  })
}
