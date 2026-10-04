import { describe, expect, it } from "vitest"
import { YakitoriErrorCode } from "../../src/kernel/errors.ts"
import {
  createMateEventEnvelope,
  MateEventType,
} from "../../src/mates/events.ts"
import { createMateId, createMateRevisionId } from "../../src/mates/ids.ts"
import { projectMate } from "../../src/mates/mate-projector.ts"

describe("mate projector", () => {
  it("rejects events from another mate", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([createdEvent(mateId), createdEvent(createMateId(), 2)]),
    ).toThrow(
      expect.objectContaining({
        code: YakitoriErrorCode.InvalidEventLog,
        message: "Mate event belongs to another mate.",
      }),
    )
  })

  it("rejects a second creation event", () => {
    const mateId = createMateId()

    expect(() =>
      projectMate([createdEvent(mateId), createdEvent(mateId, 2)]),
    ).toThrow(
      expect.objectContaining({ code: YakitoriErrorCode.InvalidEventLog }),
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
