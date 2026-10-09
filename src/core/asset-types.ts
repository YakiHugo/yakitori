export {
  assetHttpUrl,
  assetSourceKey,
  isAssetSource,
  isImageAttachment,
  isPdfAttachment,
} from "../protocol/asset-types.ts"

import type {
  AssetSource,
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

export type StoredAttachment = UserAttachment &
  Readonly<{ file: RolloutAssetReference }>

export function requireStoredAssetSource(
  source: AssetSource | undefined,
): RolloutAssetReference {
  if (source === undefined || "url" in source)
    throw new Error("Expected an owned rollout file.")
  return source
}
