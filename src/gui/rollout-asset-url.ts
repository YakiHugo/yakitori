import type { AssetSource } from "../core/asset-types.ts"
import { rolloutAssetUrl as serverAssetUrl } from "../server/asset-url.ts"

export function rolloutAssetUrl(
  file: AssetSource,
  baseUrl = window.location.origin,
): string | undefined {
  return serverAssetUrl(file, baseUrl)
}
