import { describe, expect, it } from "vitest"
import { draftToEditorParts } from "../../src/gui/input-draft.ts"
import { createInputRecoveryMemory } from "../../src/gui/input-recovery-memory.ts"
import type { InputContent } from "../../src/kernel/events.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { inputParts } from "../gui/input-fixtures.ts"

const draft = {
  apiBase: "http://localhost:4141/",
  sessionId: "session_one",
  content: inputFixture(inputParts("Continue the task")) satisfies InputContent,
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
      content: inputFixture(
        inputParts("Continue the task", [attachment]),
        { references: [annotation] }.references,
      ) satisfies InputContent,
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
      content: inputFixture(
        inputParts("Continue the task", [attachment]),
        { references: [annotation] }.references,
      ) satisfies InputContent,
      modelSelection: { provider: "codex", model: "gpt-5", effort: "high" },
    }
    const submissions = [
      submission,
      {
        ...submission,
        content: {
          ...submission.content,
          ...inputParts("Edited task", [attachment]),
        },
      },
      {
        ...submission,
        content: {
          ...submission.content,
          ...inputParts("Continue the task", [
            { ...attachment, detail: "original" as const },
          ]),
        },
      },
      {
        ...submission,
        content: {
          ...submission.content,
          references: [{ ...annotation, comment: "Check this instead" }],
        },
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
      {
        ...submission,
        content: {
          ...submission.content,
          ...inputFixture([
            { ...attachment, type: "image" },
            { type: "text", text: "Continue the task" },
          ]),
        },
      },
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
      "request_8",
    ])
  })

  it("keeps immutable recovery snapshots separate from composer and read results", () => {
    const memory = createInputRecoveryMemory(requestIds("request_first"))
    const submission = structuredClone({
      ...draft,
      content: inputFixture(
        [
          { type: "text" as const, text: "Continue the task" },
          { ...attachment, type: "image" as const },
        ] as const,
        { references: [annotation] as const }.references,
      ),
      modelSelection: { provider: "codex", model: "gpt-5" },
    })
    memory.reserveAdmission(submission)
    Object.assign(submission.content.attachments[0]?.file ?? {}, {
      path: "edited.png",
    })
    Object.assign(
      (submission.content.references?.[0] as typeof annotation).anchor,
      { endOffset: 20 },
    )
    submission.modelSelection.model = "another-model"
    const recovered = memory.readAdmissionByRequestId(
      draft.apiBase,
      draft.sessionId,
      "request_first",
    )
    expect(recovered).toEqual({
      ...draft,
      content: inputFixture(
        inputParts("Continue the task", [attachment]),
        { references: [annotation] }.references,
      ) satisfies InputContent,
      modelSelection: { provider: "codex", model: "gpt-5" },
      requestId: "request_first",
    })
    if (!recovered) throw new Error("Missing recovered input")
    const recoveredImage = draftToEditorParts(recovered.content)[1]
    if (recoveredImage?.type !== "image")
      throw new Error("Missing recovered image")
    // Mutating a caller's own copy must not affect the recovery record.
    Object.assign(recoveredImage.file, { path: "caller-edit.png" })
    expect(
      memory.listAdmissionsForSession(draft.apiBase, draft.sessionId)[0]
        ?.content,
    ).toMatchObject(inputParts("Continue the task", [attachment]))
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
      content: inputFixture(
        [
          { type: "text" as const, text: "First steer" },
          { ...structuredClone(attachment), type: "image" as const },
        ] as const,
        { references: [structuredClone(annotation)] as const }.references,
      ),
      restored: false,
    }
    const second = {
      ...first,
      requestId: "request_second",
      content: {
        ...first.content,
        ...inputParts("Second steer", [attachment]),
      },
    }
    memory.reserveSteer(draft.apiBase, draft.sessionId, first)
    memory.reserveSteer(draft.apiBase, draft.sessionId, second)
    memory.reserveSteer("http://other.test", draft.sessionId, {
      ...first,
      content: {
        ...first.content,
        ...inputParts("Other API", [attachment]),
      },
    })
    memory.reserveSteer(draft.apiBase, "session_two", {
      ...first,
      content: {
        ...first.content,
        ...inputParts("Other session", [attachment]),
      },
    })
    Object.assign(first.content.attachments[0]?.file ?? {}, {
      path: "edited.png",
    })
    Object.assign(first.content.references?.[0] ?? {}, {
      comment: "Edited comment",
    })
    expect(memory.readSteers(draft.apiBase, draft.sessionId)).toEqual([
      {
        ...first,
        content: inputFixture(
          inputParts("First steer", [attachment]),
          { references: [annotation] }.references,
        ),
      },
      {
        ...second,
        content: inputFixture(
          inputParts("Second steer", [attachment]),
          { references: [annotation] }.references,
        ),
      },
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
        .map((steer) => steer.content),
    ).toMatchObject([inputParts("Second steer", [attachment])])
    expect(
      memory
        .readSteers("http://other.test", draft.sessionId)
        .map((steer) => steer.content),
    ).toMatchObject([inputParts("Other API", [attachment])])
    expect(
      memory
        .readSteers(draft.apiBase, "session_two")
        .map((steer) => steer.content),
    ).toMatchObject([inputParts("Other session", [attachment])])
  })
})

function requestIds(...values: string[]): () => string {
  return () => {
    const value = values.shift()
    if (value !== undefined) return value
    throw new Error("Missing test request id.")
  }
}
