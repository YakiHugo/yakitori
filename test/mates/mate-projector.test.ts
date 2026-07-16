import { describe, expect, it } from "vitest"
import {
  createMateEventEnvelope,
  createMateId,
  createMateRevisionId,
  MateEventType,
  MateLifecycle,
  projectMate,
  YakitoriErrorCode,
} from "../../src/index.ts"

describe("mate projector", () => {
  it("rejects skipped profile revision numbers", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([
        createdEvent(mateId),
        createMateEventEnvelope({
          event: {
            type: MateEventType.ProfileRevised,
            data: {
              profile: profile("Revised"),
              revision: 3,
              revisionId: createMateRevisionId(),
            },
          },
          mateId,
          seq: 2,
        }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: YakitoriErrorCode.InvalidReplay }),
    )
  })

  it("rejects events from another mate", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([
        createdEvent(mateId),
        createMateEventEnvelope({
          event: {
            type: MateEventType.ProfileRevised,
            data: {
              profile: profile("Revised"),
              revision: 2,
              revisionId: createMateRevisionId(),
            },
          },
          mateId: createMateId(),
          seq: 2,
        }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: YakitoriErrorCode.InvalidReplay }),
    )
  })

  it("rejects a second creation event", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([createdEvent(mateId), createdEvent(mateId, 2)]),
    ).toThrow(
      expect.objectContaining({ code: YakitoriErrorCode.InvalidReplay }),
    )
  })

  it("rejects profile revisions while inactive", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([
        createdEvent(mateId),
        createMateEventEnvelope({
          event: {
            type: MateEventType.LifecycleChanged,
            data: { lifecycle: MateLifecycle.Inactive },
          },
          mateId,
          seq: 2,
        }),
        createMateEventEnvelope({
          event: {
            type: MateEventType.ProfileRevised,
            data: {
              profile: profile("Revised"),
              revision: 2,
              revisionId: createMateRevisionId(),
            },
          },
          mateId,
          seq: 3,
        }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: YakitoriErrorCode.InvalidReplay }),
    )
  })
})

function createdEvent(mateId: string, seq = 1) {
  return createMateEventEnvelope({
    event: {
      type: MateEventType.Created,
      data: {
        profile: profile("Initial"),
        revisionId: createMateRevisionId(),
      },
    },
    mateId,
    seq,
  })
}

function profile(instructions: string) {
  return { instructions, name: "Momo", role: "Builder" }
}
