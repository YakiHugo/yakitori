import type { ModelSelection } from "../protocol/events.ts"
import { createRequestId } from "../protocol/request-id.ts"
import type { InputContent } from "../protocol/user-input.ts"

export type AdmissionDraft = Readonly<{
  apiBase: string
  sessionId: string
  content: InputContent
  modelSelection?: ModelSelection
  supersedesRequestId?: string
}>

export type PendingAdmission = AdmissionDraft & Readonly<{ requestId: string }>

export type StoredSteer = Readonly<{
  requestId: string
  turnId: string
  content: InputContent
  restored: boolean
}>

export type InputRecoveryMemory = {
  reserveAdmission(draft: AdmissionDraft): PendingAdmission
  acknowledgeAdmission(admission: PendingAdmission): void
  readAdmissionByRequestId(
    apiBase: string,
    sessionId: string,
    requestId: string,
  ): PendingAdmission | undefined
  listAdmissionsForApiBase(apiBase: string): PendingAdmission[]
  listAdmissionsForSession(
    apiBase: string,
    sessionId: string,
  ): PendingAdmission[]
  readSteers(apiBase: string, sessionId: string): readonly StoredSteer[]
  reserveSteer(apiBase: string, sessionId: string, steer: StoredSteer): void
  updateSteers(
    apiBase: string,
    sessionId: string,
    update: (pending: readonly StoredSteer[]) => readonly StoredSteer[],
  ): void
  clear(): void
}

// Submissions survive navigation and reconnects for this renderer's lifetime.
// Copies at the boundary keep later composer edits out of the submitted intent.
export function createInputRecoveryMemory(
  generateRequestId: () => string = createRequestId,
): InputRecoveryMemory {
  const admissions = new Map<string, PendingAdmission>()
  const steers = new Map<string, Map<string, readonly StoredSteer[]>>()

  const listAdmissionsForApiBase = (apiBase: string): PendingAdmission[] => {
    const normalizedApiBase = normalizeApiBase(apiBase)
    return [...admissions.values()]
      .filter((admission) => admission.apiBase === normalizedApiBase)
      .map((admission) => structuredClone(admission))
  }
  const listAdmissionsForSession = (
    apiBase: string,
    sessionId: string,
  ): PendingAdmission[] =>
    listAdmissionsForApiBase(apiBase).filter(
      (admission) => admission.sessionId === sessionId,
    )
  const readSteers = (
    apiBase: string,
    sessionId: string,
  ): readonly StoredSteer[] =>
    structuredClone(steers.get(normalizeApiBase(apiBase))?.get(sessionId) ?? [])
  const updateSteers = (
    apiBase: string,
    sessionId: string,
    update: (pending: readonly StoredSteer[]) => readonly StoredSteer[],
  ): void => {
    const normalizedApiBase = normalizeApiBase(apiBase)
    const next = structuredClone(update(readSteers(apiBase, sessionId)))
    const sessions =
      steers.get(normalizedApiBase) ?? new Map<string, readonly StoredSteer[]>()
    if (next.length > 0) {
      sessions.set(sessionId, next)
      steers.set(normalizedApiBase, sessions)
    } else {
      sessions.delete(sessionId)
      if (sessions.size === 0) steers.delete(normalizedApiBase)
    }
  }

  return {
    reserveAdmission(draft: AdmissionDraft): PendingAdmission {
      const snapshot = structuredClone({
        ...draft,
        apiBase: normalizeApiBase(draft.apiBase),
      })
      const key = admissionIdentity(snapshot)
      let admission = admissions.get(key)
      if (admission === undefined) {
        admission = { ...snapshot, requestId: generateRequestId() }
        admissions.set(key, admission)
      }
      return structuredClone(admission)
    },
    acknowledgeAdmission(admission: PendingAdmission): void {
      const key = admissionIdentity(admission)
      if (admissions.get(key)?.requestId === admission.requestId)
        admissions.delete(key)
    },
    readAdmissionByRequestId(
      apiBase: string,
      sessionId: string,
      requestId: string,
    ): PendingAdmission | undefined {
      return listAdmissionsForSession(apiBase, sessionId).find(
        (admission) => admission.requestId === requestId,
      )
    },
    listAdmissionsForApiBase,
    listAdmissionsForSession,
    readSteers,
    reserveSteer(apiBase: string, sessionId: string, steer: StoredSteer): void {
      updateSteers(apiBase, sessionId, (pending) => [...pending, steer])
    },
    updateSteers,
    clear(): void {
      admissions.clear()
      steers.clear()
    },
  }
}

export const inputRecoveryMemory = createInputRecoveryMemory()

function normalizeApiBase(value: string): string {
  const url = new URL(value)
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`
  return url.toString()
}

// Identity includes the full submission, including the model and any replaced
// first-input request. Empty optional attachment lists mean the same command.
function admissionIdentity(draft: AdmissionDraft): string {
  return JSON.stringify(
    [
      draft.apiBase,
      draft.sessionId,
      {
        ...draft.content,
        references: draft.content.references ?? [],
      },
      draft.modelSelection ?? null,
      draft.supersedesRequestId ?? null,
    ],
    (_key, value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
  )
}
