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

export function isAssetRolloutId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)
}

export function isAssetSource(value: unknown): value is AssetSource {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const source = value as Record<string, unknown>
  return "url" in source
    ? Object.keys(source).length === 1 && assetHttpUrl(source.url) !== undefined
    : Object.keys(source).every(
        (key) => key === "rolloutId" || key === "path",
      ) &&
        isAssetRolloutId(source.rolloutId) &&
        typeof source.path === "string"
}

export function assetHttpUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined
  const url = URL.parse(value)
  return url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password
    ? url.href
    : undefined
}

export function assetSourceKey(source: AssetSource): string {
  return "url" in source ? source.url : `${source.rolloutId}\0${source.path}`
}

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const image = value as Record<string, unknown>
  return (
    Object.keys(image).every((key) =>
      ["name", "mediaType", "detail", "file", "sizeBytes"].includes(key),
    ) &&
    typeof image.name === "string" &&
    typeof image.mediaType === "string" &&
    ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
      image.mediaType,
    ) &&
    (image.detail === undefined ||
      image.detail === "high" ||
      image.detail === "original") &&
    typeof image.sizeBytes === "number" &&
    Number.isSafeInteger(image.sizeBytes) &&
    image.sizeBytes >= 0 &&
    isAssetSource(image.file)
  )
}

export function isPdfAttachment(value: unknown): value is PdfAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const pdf = value as Record<string, unknown>
  return (
    Object.keys(pdf).every((key) =>
      ["name", "mediaType", "file", "sizeBytes"].includes(key),
    ) &&
    typeof pdf.name === "string" &&
    pdf.name.length > 0 &&
    pdf.mediaType === "application/pdf" &&
    typeof pdf.sizeBytes === "number" &&
    Number.isSafeInteger(pdf.sizeBytes) &&
    pdf.sizeBytes >= 0 &&
    isAssetSource(pdf.file)
  )
}
