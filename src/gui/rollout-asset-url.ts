import type { RolloutAssetReference } from "../kernel/events.ts"
import { isStorageKey } from "../kernel/ids.ts"

// Render only the server's asset route, never a path that URL normalization
// could turn into another endpoint or an external navigation.
export function rolloutAssetUrl(
  file: RolloutAssetReference,
  apiBase: string,
): string | undefined {
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
