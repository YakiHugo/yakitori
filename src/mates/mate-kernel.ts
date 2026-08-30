import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"
import { MateEventType, MateProfileLimit, type MateProfile } from "./events.ts"
import { createMateId, createMateRevisionId, isMateId } from "./ids.ts"
import {
  projectMate,
  type MateProjection,
  type MateSummary,
} from "./mate-projector.ts"
import type { MateStore } from "./mate-store.ts"

export type MateKernel = {
  createMate(input: CreateMateInput): Promise<CreateMateResult>
  listMates(input?: ListMatesInput): Promise<ListMatesResult>
  readMate(input: ReadMateInput): Promise<ReadMateResult>
}

export type CreateMateInput = MateProfile
export type ListMatesInput = {
  readonly cursor?: string
  readonly limit?: number
}
export type ReadMateInput = { readonly mateId: string }

export type CreateMateResult = { readonly mate: MateProjection }
export type ListMatesResult = {
  readonly mates: readonly MateSummary[]
  readonly nextCursor?: string
}
export type ReadMateResult = { readonly mate?: MateProjection }

export function createMateKernel(store: MateStore): MateKernel {
  return {
    async createMate(input) {
      const profile = requireMateProfile(input)
      const mateId = createMateId()
      await store.appendEvent(
        mateId,
        {
          type: MateEventType.Created,
          data: {
            profile,
            revisionId: createMateRevisionId(),
          },
        },
        { expectedSeq: 0 },
      )
      return { mate: await readRequiredMate(store, mateId) }
    },

    async listMates(input = {}) {
      if (input.cursor !== undefined) requireMateId(input.cursor)
      return store.listMates(input)
    },

    async readMate(input) {
      requireMateId(input.mateId)
      const mate = projectMate(await store.readEvents(input.mateId))
      if (mate) return { mate }
      return {}
    },
  }
}

function requireMateProfile(input: MateProfile): MateProfile {
  return {
    instructions: requireBoundedString(
      input.instructions,
      "instructions",
      MateProfileLimit.Instructions,
      true,
    ),
    name: requireBoundedString(input.name, "name", MateProfileLimit.Label),
    role: requireBoundedString(input.role, "role", MateProfileLimit.Label),
  }
}

function requireBoundedString(
  value: string,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value === "string" &&
    value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0)
  ) {
    return value
  }
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: `Mate ${field} must be ${allowEmpty ? "at most" : "between 1 and"} ${maximumLength} characters.`,
    details: { field, maximumLength },
  })
}

async function readRequiredMate(
  store: MateStore,
  mateId: string,
): Promise<MateProjection> {
  requireMateId(mateId)
  const mate = projectMate(await store.readEvents(mateId))
  if (mate) return mate
  throw createYakitoriError({
    code: YakitoriErrorCode.NotFound,
    message: `Mate ${mateId} was not found.`,
    details: { mateId },
  })
}

function requireMateId(mateId: string): void {
  if (isMateId(mateId)) return
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message: "Mate id is invalid.",
    details: { mateId },
  })
}
