import type { Translate } from "../i18n/messages.ts"

export function formatElapsed(seconds: number, t: Translate): string {
  if (seconds < 60) return t("{0}s", seconds)
  const minutes = Math.floor(seconds / 60)
  return t("{0}m {1}s", minutes, seconds % 60)
}
