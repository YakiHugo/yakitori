import type {
  AssetSource,
  RolloutAssetReference,
} from "../../src/protocol/asset-types.ts"

export function requireStoredAssetSource(
  source: AssetSource | undefined,
): RolloutAssetReference {
  if (source === undefined || "url" in source)
    throw new Error("Expected an owned rollout file.")
  return source
}
