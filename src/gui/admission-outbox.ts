import type { ImageAttachment, ModelSelection } from "../kernel/events.ts"
import { createRequestId, isRequestId } from "../kernel/ids.ts"
import type { ContextExcerpt } from "../kernel/input-context.ts"

// An admission draft is the complete immutable submission: the model selection
// is part of the identity, so retrying after a model change reserves a fresh
// request id instead of conflicting with the server's recorded fingerprint.
export type AdmissionDraft = {
  readonly apiBase: string
  readonly sessionId: string
  readonly text: string
  readonly attachments?: readonly ImageAttachment[]
  readonly contextAttachments?: readonly ContextExcerpt[]
  readonly modelSelection?: ModelSelection
  readonly supersedesRequestId?: string
}

export type PendingAdmission = AdmissionDraft & {
  readonly requestId: string
}

export type AdmissionStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>

type StoredAdmission = {
  readonly requestId: string
  readonly draft: AdmissionDraft
}

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
  const stored = readStoredAdmission(storage.getItem(key))
  if (stored !== undefined) {
    return {
      ...normalizedDraft,
      requestId: stored.requestId,
    }
  }

  const requestId = generateRequestId()
  const storedAdmission: StoredAdmission = {
    requestId,
    draft: normalizedDraft,
  }
  storage.setItem(key, JSON.stringify(storedAdmission))
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
  const stored = readStoredAdmission(storage.getItem(key))
  if (stored?.requestId !== admission.requestId) return
  storage.removeItem(key)
}

export function readAdmissionByRequestId(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  apiBase: string,
  sessionId: string,
  requestId: string,
): PendingAdmission | undefined {
  return listAdmissionsForSession(storage, apiBase, sessionId).find(
    (admission) => admission.requestId === requestId,
  )
}

export function listAdmissionsForSession(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  apiBase: string,
  sessionId: string,
): PendingAdmission[] {
  return listAdmissionsForApiBase(storage, apiBase).filter(
    (admission) => admission.sessionId === sessionId,
  )
}

export function listAdmissionsForApiBase(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  apiBase: string,
): PendingAdmission[] {
  const normalizedApiBase = normalizeApiBase(apiBase)
  const admissions: PendingAdmission[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith("yakitori.admission.v1:")) continue
    const stored = readStoredAdmission(storage.getItem(key))
    if (stored === undefined || stored.draft.apiBase !== normalizedApiBase)
      continue
    admissions.push({ ...stored.draft, requestId: stored.requestId })
  }
  return admissions
}

export function normalizeApiBase(value: string): string {
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`
  return url.toString()
}

// The in-memory snapshots are validated before retrying so a damaged entry
// cannot reserve an unrelated request id.
function readStoredAdmission(
  value: string | null,
): StoredAdmission | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "requestId" in parsed &&
      typeof parsed.requestId === "string" &&
      isRequestId(parsed.requestId) &&
      "draft" in parsed &&
      typeof parsed.draft === "object" &&
      parsed.draft !== null &&
      "apiBase" in parsed.draft &&
      typeof parsed.draft.apiBase === "string" &&
      "sessionId" in parsed.draft &&
      typeof parsed.draft.sessionId === "string" &&
      "text" in parsed.draft &&
      typeof parsed.draft.text === "string" &&
      (!("supersedesRequestId" in parsed.draft) ||
        (typeof parsed.draft.supersedesRequestId === "string" &&
          isRequestId(parsed.draft.supersedesRequestId)))
    ) {
      return parsed as StoredAdmission
    }
  } catch {
    // A damaged snapshot is ignored and re-reserved below.
  }
  return undefined
}

async function storageKey(draft: AdmissionDraft): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        draft.apiBase,
        draft.sessionId,
        draft.text,
        draft.attachments ?? [],
        draft.contextAttachments ?? [],
        draft.modelSelection ?? null,
        draft.supersedesRequestId ?? null,
      ]),
    ),
  )
  return `yakitori.admission.v1:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`
}
