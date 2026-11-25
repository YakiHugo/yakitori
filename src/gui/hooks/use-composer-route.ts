import { resolveEffectiveModel, useAppStore } from "../store/app-store.ts"
import { useModelRoutePreview } from "./use-model-route-preview.ts"

export type ComposerRoute = ReturnType<typeof useComposerRoute>

export function useComposerRoute(enabled = true) {
  const sessionId = useAppStore((state) => state.selection.sessionId)
  const sessionCurrent = useAppStore((state) =>
    sessionId === undefined
      ? state.draftModelSelection
      : state.modelSelections[sessionId],
  )
  const userPreference = useAppStore((state) => state.userPreference)
  const defaultProvider = useAppStore((state) => state.defaultProvider)
  const defaultModel = useAppStore((state) => state.defaultModel)
  const requiresImages = useAppStore(
    (state) =>
      state.promptDraft?.attachments.some((attachment) =>
        attachment.mediaType.startsWith("image/"),
      ) ?? false,
  )
  const effectiveModel = resolveEffectiveModel({
    sessionCurrent,
    userPreference,
    defaultProvider,
    defaultModel,
  })
  const result = useModelRoutePreview(
    enabled ? effectiveModel : undefined,
    requiresImages ? { inputModalities: ["image"] } : {},
    sessionId,
  )
  return { effectiveModel, preview: result?.preview }
}
