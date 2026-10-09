export type RolloutAssetReference = Readonly<{
  rolloutId: string
  path: string
}>

// Like Codex image references, the source names stored content or a URL.
// Provider file IDs are request adaptation state, never a portable asset source.
export type AssetSource = RolloutAssetReference | Readonly<{ url: string }>

export type ImageDetail = "high" | "original"

export type ImageAttachment = Readonly<{
  name: string
  mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
  sizeBytes: number
  detail?: ImageDetail
  file: AssetSource
}>

export type PdfAttachment = Readonly<{
  name: string
  mediaType: "application/pdf"
  sizeBytes: number
  file: AssetSource
}>

export type UserAttachment = ImageAttachment | PdfAttachment
