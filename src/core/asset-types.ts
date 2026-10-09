import type {
  AssetSource,
  ImageAttachment,
  PdfAttachment,
  RolloutAssetReference,
  UserAttachment,
} from "../protocol/asset-types.ts"

export type {
  AssetSource,
  ImageAttachment,
  ImageDetail,
  PdfAttachment,
  RolloutAssetReference,
  UserAttachment,
} from "../protocol/asset-types.ts"

import { isStorageKey } from "../kernel/ids.ts"
export type StoredAttachment = UserAttachment &
  Readonly<{ file: RolloutAssetReference }>

export function isAssetSource(value: unknown): value is AssetSource {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const source = value as Record<string, unknown>
  return "url" in source
    ? Object.keys(source).length === 1 && assetHttpUrl(source.url) !== undefined
    : Object.keys(source).every(
        (key) => key === "rolloutId" || key === "path",
      ) &&
        isStorageKey(source.rolloutId) &&
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

export function requireStoredAssetSource(
  source: AssetSource | undefined,
): RolloutAssetReference {
  if (source === undefined || "url" in source)
    throw new Error("Expected an owned rollout file.")
  return source
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
