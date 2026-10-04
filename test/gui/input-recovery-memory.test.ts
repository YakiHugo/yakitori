import { describe, expect, it } from "vitest"
import { createInputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"

const draft = {
  apiBase: "http://localhost:4141/",
  sessionId: "session_one",
  text: "Continue the task",
}
const attachment = {
  name: "screen.png",
  mediaType: "image/png" as const,
  sizeBytes: 12,
  detail: "high" as const,
  file: { rolloutId: "draft_one", path: "attachments/1.png" },
}
const annotation = {
  id: "annotation-1",
  kind: "annotation" as const,
  text: "Selected answer",
  comment: "Explain this",
  anchor: { startOffset: 0, endOffset: 15 },
  source: {
    kind: "message" as const,
    label: "Assistant",
    messageId: "answer-1",
  },
}

describe("input recovery memory", () => {
  it("reuses a request id for equivalent complete submission content", () => {
    const memory = createInputRecoveryMemory(requestIds("request_first"))
    const submission = {
      ...draft,
      attachments: [attachment],
      contextAttachments: [annotation],
      modelSelection: { provider: "codex", model: "gpt-5", effort: "high" },
    }
    const first = memory.reserveAdmission(submission)
    expect(memory.reserveAdmission(structuredClone(submission))).toEqual(first)
    expect(
      memory.reserveAdmission({
        ...submission,
        modelSelection: { effort: "high", model: "gpt-5", provider: "codex" },
      }),
    ).toEqual(first)
    expect(
      memory.listAdmissionsForSession(draft.apiBase, draft.sessionId),
    ).toEqual([first])
  })

  it("isolates API endpoints and sessions and normalizes equivalent URLs", () => {
    const memory = createInputRecoveryMemory(
      requestIds("request_first", "request_api", "request_session"),
    )
    const first = memory.reserveAdmission({
      ...draft,
      apiBase: "HTTP://LOCALHOST:80/api?ignored=yes#fragment",
    })
    expect(
      memory.reserveAdmission({ ...draft, apiBase: "http://localhost/api/" }),
    ).toEqual(first)
    const otherApi = memory.reserveAdmission(draft)
    const otherSession = memory.reserveAdmission({
      ...draft,
      sessionId: "session_two",
    })
    expect(memory.listAdmissionsForApiBase(draft.apiBase)).toEqual([
      otherApi,
      otherSession,
    ])
    expect(
      memory.readAdmissionByRequestId(
        draft.apiBase,
        "session_two",
        otherApi.requestId,
      ),
    ).toBeUndefined()
    expect(
      memory.readAdmissionByRequestId(
        "http://localhost/api",
        draft.sessionId,
        first.requestId,
      ),
    ).toEqual(first)
  })

  it("reserves new requests when any submission content changes", () => {
    let sequence = 0
    const memory = createInputRecoveryMemory(() => `request_${++sequence}`)
    const submission = {
      ...draft,
      attachments: [attachment],
      contextAttachments: [annotation],
      modelSelection: { provider: "codex", model: "gpt-5", effort: "high" },
    }
    const submissions = [
      submission,
      { ...submission, text: "Edited task" },
      {
        ...submission,
        attachments: [{ ...attachment, detail: "original" as const }],
      },
      {
        ...submission,
        contextAttachments: [{ ...annotation, comment: "Check this instead" }],
      },
      {
        ...submission,
        modelSelection: { ...submission.modelSelection, effort: "low" },
      },
      {
        ...submission,
        modelSelection: { ...submission.modelSelection, speed: "fast" },
      },
      { ...submission, supersedesRequestId: "request_replaced" },
    ]
    expect(
      submissions.map((value) => memory.reserveAdmission(value).requestId),
    ).toEqual([
      "request_1",
      "request_2",
      "request_3",
      "request_4",
      "request_5",
      "request_6",
      "request_7",
    ])
  })

  it("keeps immutable recovery snapshots separate from composer and read results", () => {
    const memory = createInputRecoveryMemory(requestIds("request_first"))
    const submission = structuredClone({
      ...draft,
      attachments: [attachment] as const,
      contextAttachments: [annotation] as const,
      modelSelection: { provider: "codex", model: "gpt-5" },
    })
    memory.reserveAdmission(submission)
    submission.attachments[0].file.path = "edited.png"
    submission.contextAttachments[0].anchor.endOffset = 20
    submission.modelSelection.model = "another-model"
    const recovered = memory.readAdmissionByRequestId(
      draft.apiBase,
      draft.sessionId,
      "request_first",
    )
    expect(recovered).toEqual({
      ...draft,
      attachments: [attachment],
      contextAttachments: [annotation],
      modelSelection: { provider: "codex", model: "gpt-5" },
      requestId: "request_first",
    })
    if (!recovered?.attachments?.[0]) throw new Error("Missing recovered image")
    // Mutating a caller's own copy must not affect the recovery record.
    Object.assign(recovered.attachments[0].file, { path: "caller-edit.png" })
    expect(
      memory.listAdmissionsForSession(draft.apiBase, draft.sessionId)[0]
        ?.attachments,
    ).toEqual([attachment])
  })

  it("removes only the matching admission and ignores old acknowledgements", () => {
    const memory = createInputRecoveryMemory(
      requestIds("request_first", "request_new"),
    )
    const first = memory.reserveAdmission(draft)
    memory.acknowledgeAdmission({ ...first, requestId: "request_stale" })
    expect(memory.reserveAdmission(draft)).toEqual(first)
    memory.acknowledgeAdmission(first)
    const newer = memory.reserveAdmission(draft)
    memory.acknowledgeAdmission(first)
    expect(memory.reserveAdmission(draft)).toEqual(newer)
    memory.acknowledgeAdmission(newer)
    expect(memory.listAdmissionsForApiBase(draft.apiBase)).toEqual([])
  })

  it("preserves isolated steer snapshots and their recovery order", () => {
    const memory = createInputRecoveryMemory()
    const first = {
      requestId: "request_first",
      turnId: "turn_one",
      text: "First steer",
      attachments: [structuredClone(attachment)] as const,
      excerpts: [structuredClone(annotation)] as const,
      restored: false,
    }
    const second = {
      ...first,
      requestId: "request_second",
      text: "Second steer",
    }
    memory.reserveSteer(draft.apiBase, draft.sessionId, first)
    memory.reserveSteer(draft.apiBase, draft.sessionId, second)
    memory.reserveSteer("http://other.test", draft.sessionId, {
      ...first,
      text: "Other API",
    })
    memory.reserveSteer(draft.apiBase, "session_two", {
      ...first,
      text: "Other session",
    })
    first.attachments[0].file.path = "edited.png"
    first.excerpts[0].comment = "Edited comment"
    expect(memory.readSteers(draft.apiBase, draft.sessionId)).toEqual([
      { ...first, attachments: [attachment], excerpts: [annotation] },
      { ...second, attachments: [attachment], excerpts: [annotation] },
    ])
    memory.updateSteers(draft.apiBase, draft.sessionId, (steers) =>
      steers.map((steer) => ({ ...steer, restored: true })),
    )
    expect(
      memory
        .readSteers(draft.apiBase, draft.sessionId)
        .map(({ requestId, restored }) => [requestId, restored]),
    ).toEqual([
      ["request_first", true],
      ["request_second", true],
    ])
    memory.updateSteers(draft.apiBase, draft.sessionId, (steers) =>
      steers.filter((steer) => steer.requestId !== "request_first"),
    )
    expect(
      memory
        .readSteers(draft.apiBase, draft.sessionId)
        .map((steer) => steer.text),
    ).toEqual(["Second steer"])
    expect(
      memory
        .readSteers("http://other.test", draft.sessionId)
        .map((steer) => steer.text),
    ).toEqual(["Other API"])
    expect(
      memory
        .readSteers(draft.apiBase, "session_two")
        .map((steer) => steer.text),
    ).toEqual(["Other session"])
  })
})

function requestIds(...values: string[]): () => string {
  return () => {
    const value = values.shift()
    if (value !== undefined) return value
    throw new Error("Missing test request id.")
  }
}
