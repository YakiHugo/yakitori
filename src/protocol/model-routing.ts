import type { ModelSelection } from "./events.ts"

export type ModelRouteRequirements = Readonly<{
  inputModalities?: readonly ("text" | "image" | "video")[]
  imageDetail?: "high" | "original"
  contextWindowTokens?: number
}>

export type ModelRouteRejection = Readonly<{
  accountId: string
  model: string
  code:
    | "model_unavailable"
    | "unsupported_modality"
    | "unsupported_image_detail"
    | "unsupported_effort"
    | "unsupported_speed"
    | "budget_exceeded"
  message: string
}>

export type ModelRoutePreviewRequest = Readonly<{
  selection: ModelSelection
  sessionId?: string
  requirements?: ModelRouteRequirements
}>

// These options describe executable alternatives for the other selected
// parameters and input requirements, rather than independent capability unions.
export type ModelRoutePreview = Readonly<{
  available: boolean
  target?: ModelSelection
  defaultEffort?: string
  efforts: readonly string[]
  speeds: readonly string[]
  inputModalities: readonly ("text" | "image" | "video")[]
  imageDetailModes: readonly ("high" | "original")[]
  rejections: readonly ModelRouteRejection[]
}>

export type ModelRoutePreviewer = (
  request: ModelRoutePreviewRequest,
) => Promise<ModelRoutePreview>
