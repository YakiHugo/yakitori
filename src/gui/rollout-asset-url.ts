import type { AssetSource } from "../protocol/asset-types.ts"
import { rolloutAssetUrl as serverAssetUrl } from "../protocol/asset-url.ts"

export function rolloutAssetUrl(
  file: AssetSource,
  baseUrl = window.location.origin,
): string | undefined {
  return serverAssetUrl(file, baseUrl)
}
