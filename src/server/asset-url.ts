import { type AssetSource, assetHttpUrl } from "../core/asset-types.ts"
import { isStorageKey } from "../kernel/ids.ts"

export function requireAssetBaseUrl(value: string): string {
  const valid = assetHttpUrl(value)
  const url = valid === undefined ? undefined : URL.parse(valid)
  if (url === undefined || url === null || url.search || url.hash)
    throw new TypeError(
      "Asset base URL must be an HTTP(S) address without credentials, query or fragment.",
    )
  return url.href.endsWith("/") ? url.href : `${url.href}/`
}

// Render only the server's asset route, never a path that URL normalization
// could turn into another endpoint or an external navigation.
export function rolloutAssetUrl(
  file: AssetSource,
  apiBase: string,
): string | undefined {
  if ("url" in file) return assetHttpUrl(file.url)
  const segments = file.path.split("/")
  if (
    !isStorageKey(file.rolloutId) ||
    !["tools", "attachments"].includes(segments[0] ?? "") ||
    segments.length < 3 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        [...segment].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    return undefined
  try {
    const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`)
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      return undefined
    return new URL(
      `rollouts/${encodeURIComponent(file.rolloutId)}/assets/${segments.map(encodeURIComponent).join("/")}`,
      base,
    ).toString()
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}
