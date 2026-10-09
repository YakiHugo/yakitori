import type {
  AssetSource,
  ImageAttachment,
  ImageDetail,
} from "./asset-types.ts"
import type { JsonObject } from "./events.ts"

// Portable conversation records belong to Session persistence. Providers adapt
// them at the wire boundary without replacing stored sources with native IDs.
export type ModelTextBlock = Readonly<{
  type: "text"
  text: string
  providerMetadata?: JsonObject
}>

export type ModelImageBlock =
  | Readonly<{
      type: "image"
      mediaType: ImageAttachment["mediaType"]
      detail?: ImageDetail
      data: string
      file?: never
      sizeBytes?: never
    }>
  | Readonly<{
      type: "image"
      mediaType: ImageAttachment["mediaType"]
      detail?: ImageDetail
      file: AssetSource
      sizeBytes: number
      name?: string
      data?: never
    }>

export type ModelDocumentBlock = Readonly<{
  type: "document"
  name: string
  mediaType: "application/pdf"
  sizeBytes: number
  file: AssetSource
  // Request-only; durable history retains the asset reference.
  data?: string
}>

// Tool content is data, not an assistant continuation or a host/UI metadata channel.
export type ModelToolContentBlock =
  | Readonly<{
      type: "text"
      text: string
    }>
  | ModelImageBlock
  | ModelDocumentBlock
