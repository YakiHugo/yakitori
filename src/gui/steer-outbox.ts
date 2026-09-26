import { isImageAttachment, type ImageAttachment } from "../kernel/events.ts"
import { isRequestId } from "../kernel/ids.ts"
import {
  isContextExcerpts,
  type ContextExcerpt,
} from "../kernel/input-context.ts"

export type StoredSteer = Readonly<{
  requestId: string
  turnId: string
  text: string
  attachments: readonly ImageAttachment[]
  excerpts: readonly ContextExcerpt[]
  restored: boolean
}>

type SteerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function key(apiBase: string, sessionId: string): string {
  return `yakitori.steer.v1:${encodeURIComponent(apiBase)}:${encodeURIComponent(sessionId)}`
}

export function readSteers(
  storage: SteerStorage,
  apiBase: string,
  sessionId: string,
): readonly StoredSteer[] {
  const value = storage.getItem(key(apiBase, sessionId))
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is StoredSteer => {
      if (typeof item !== "object" || item === null) return false
      const steer = item as Record<string, unknown>
      return (
        typeof steer.requestId === "string" &&
        isRequestId(steer.requestId) &&
        typeof steer.turnId === "string" &&
        steer.turnId.length > 0 &&
        typeof steer.text === "string" &&
        Array.isArray(steer.attachments) &&
        steer.attachments.every(isImageAttachment) &&
        isContextExcerpts(steer.excerpts) &&
        typeof steer.restored === "boolean"
      )
    })
  } catch {
    // A damaged local storage entry cannot be recovered.
    return []
  }
}

function writeSteers(
  storage: SteerStorage,
  apiBase: string,
  sessionId: string,
  steers: readonly StoredSteer[],
): void {
  const storageKey = key(apiBase, sessionId)
  if (steers.length === 0) storage.removeItem(storageKey)
  else storage.setItem(storageKey, JSON.stringify(steers))
}

export function reserveSteer(
  storage: SteerStorage,
  apiBase: string,
  sessionId: string,
  steer: StoredSteer,
): void {
  writeSteers(storage, apiBase, sessionId, [
    ...readSteers(storage, apiBase, sessionId),
    steer,
  ])
}

export function updateSteers(
  storage: SteerStorage,
  apiBase: string,
  sessionId: string,
  update: (steers: readonly StoredSteer[]) => readonly StoredSteer[],
): void {
  writeSteers(
    storage,
    apiBase,
    sessionId,
    update(readSteers(storage, apiBase, sessionId)),
  )
}
