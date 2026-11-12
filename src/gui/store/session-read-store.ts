import { create } from "zustand"

const STORAGE_PREFIX = "yakitori.sessionReadSeq:"

export function sessionReadKey(apiBase: string, sessionId: string): string {
  return JSON.stringify([apiBase, sessionId])
}

function initialReadSeqs(): Record<string, number> {
  const storage = globalThis.localStorage
  const readSeqs: Record<string, number> = {}
  for (let index = 0; index < (storage?.length ?? 0); index++) {
    const key = storage.key(index)
    if (!key?.startsWith(STORAGE_PREFIX)) continue
    const seq = Number(storage.getItem(key))
    if (Number.isSafeInteger(seq) && seq > 0)
      readSeqs[key.slice(STORAGE_PREFIX.length)] = seq
  }
  return readSeqs
}

type SessionReadStore = {
  readSeqs: Record<string, number>
  markRead(apiBase: string, sessionId: string, completionSeq: number): void
  syncFromStorage(): void
}

export const useSessionReadStore = create<SessionReadStore>((set, get) => ({
  readSeqs: initialReadSeqs(),
  markRead(apiBase, sessionId, completionSeq) {
    const key = sessionReadKey(apiBase, sessionId)
    const stored = Number(localStorage.getItem(STORAGE_PREFIX + key))
    const persisted = Number.isSafeInteger(stored) && stored > 0 ? stored : 0
    const current = get().readSeqs[key] ?? 0
    const next = Math.max(current, persisted, completionSeq)
    // Each session owns one key so another tab cannot replace unrelated reads.
    if (next > persisted)
      localStorage.setItem(STORAGE_PREFIX + key, String(next))
    if (next > current) set({ readSeqs: { ...get().readSeqs, [key]: next } })
  },
  syncFromStorage() {
    const stored = initialReadSeqs()
    const current = get().readSeqs
    const readSeqs = { ...stored }
    for (const [key, seq] of Object.entries(current)) {
      readSeqs[key] = Math.max(seq, stored[key] ?? 0)
      // Concurrent writes of the same session converge on the highest read.
      if (seq > (stored[key] ?? 0))
        localStorage.setItem(STORAGE_PREFIX + key, String(seq))
    }
    if (Object.entries(readSeqs).some(([key, seq]) => current[key] !== seq))
      set({ readSeqs })
  },
}))
