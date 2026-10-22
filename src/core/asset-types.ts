export {
  assetHttpUrl,
  assetSourceKey,
  isAssetSource,
  isImageAttachment,
  isPdfAttachment,
} from "../protocol/asset-types.ts"

import type {
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
