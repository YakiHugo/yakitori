import { createRequestId, isRequestId } from "../kernel/ids.ts"

export type AdmissionDraft = {
  readonly apiBase: string
  readonly sessionId: string
  readonly text: string
}

export type PendingAdmission = AdmissionDraft & {
  readonly requestId: string
}

export type AdmissionStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>

export async function reserveAdmission(
  storage: AdmissionStorage,
  draft: AdmissionDraft,
  generateRequestId: () => string = createRequestId,
): Promise<PendingAdmission> {
  const normalizedDraft = {
    ...draft,
    apiBase: normalizeApiBase(draft.apiBase),
  }
  const key = await storageKey(normalizedDraft)
  const storedRequestId = storage.getItem(key)
  if (storedRequestId !== null && isRequestId(storedRequestId)) {
    return {
      ...normalizedDraft,
      requestId: storedRequestId,
    }
  }

  const requestId = generateRequestId()
  storage.setItem(key, requestId)
  return {
    ...normalizedDraft,
    requestId,
  }
}

export async function acknowledgeAdmission(
  storage: AdmissionStorage,
  admission: PendingAdmission,
): Promise<void> {
  const key = await storageKey(admission)
  if (storage.getItem(key) !== admission.requestId) return
  storage.removeItem(key)
}

export function normalizeApiBase(value: string): string {
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`
  return url.toString()
}

async function storageKey(draft: AdmissionDraft): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([draft.apiBase, draft.sessionId, draft.text]),
    ),
  )
  return `yakitori.admission.v1:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`
}
