import { describe, expect, it } from "vitest"
import {
  type AdmissionStorage,
  acknowledgeAdmission,
  normalizeApiBase,
  reserveAdmission,
} from "../../src/gui/admission-outbox.ts"

describe("admission outbox", () => {
  it("retries the same structured context and reserves a new input after an annotation changes", async () => {
    const storage = createMemoryStorage()
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
    const draft = {
      apiBase: "http://localhost:4141",
      sessionId: "session_one",
      text: "",
      contextAttachments: [annotation],
    }
    const first = await reserveAdmission(storage, draft, () => "request_first")
    expect(
      await reserveAdmission(
        storage,
        structuredClone(draft),
        () => "request_unused",
      ),
    ).toEqual(first)
    const edited = await reserveAdmission(
      storage,
      {
        ...draft,
        contextAttachments: [{ ...annotation, comment: "Check this instead" }],
      },
      () => "request_edited",
    )
    expect(edited.requestId).toBe("request_edited")
  })
  it("reuses a request id for the same API, session, and draft", async () => {
    const storage = createMemoryStorage()
    const draft = {
      apiBase: "http://127.0.0.1:4141/",
      sessionId: "session_one",
      text: "Continue the task",
    }

    const first = await reserveAdmission(storage, draft, () => "request_first")
    const afterReload = await reserveAdmission(
      storage,
      draft,
      () => "request_second",
    )

    expect(afterReload).toEqual(first)
    expect(storage.keys()).toEqual([
      expect.stringMatching(/^yakitori\.admission\.v1:[a-f0-9]{64}$/),
    ])
    expect(storage.keys()[0]).not.toContain(draft.text)
  })

  it("keeps independent request ids for different admission commands", async () => {
    const storage = createMemoryStorage()
    const generateRequestId = requestIds(
      "request_api",
      "request_session",
      "request_text",
      "request_draft",
    )

    const admissions = [
      await reserveAdmission(
        storage,
        {
          apiBase: "http://127.0.0.1:4141/",
          sessionId: "session_one",
          text: "Draft",
        },
        generateRequestId,
      ),
      await reserveAdmission(
        storage,
        {
          apiBase: "http://127.0.0.1:4242/",
          sessionId: "session_one",
          text: "Draft",
        },
        generateRequestId,
      ),
      await reserveAdmission(
        storage,
        {
          apiBase: "http://127.0.0.1:4141/",
          sessionId: "session_two",
          text: "Draft",
        },
        generateRequestId,
      ),
      await reserveAdmission(
        storage,
        {
          apiBase: "http://127.0.0.1:4141/",
          sessionId: "session_one",
          text: "Different draft",
        },
        generateRequestId,
      ),
    ]

    expect(admissions.map((admission) => admission.requestId)).toEqual([
      "request_api",
      "request_session",
      "request_text",
      "request_draft",
    ])
  })

  it("removes a request id only after its matching acknowledgement", async () => {
    const storage = createMemoryStorage()
    const draft = {
      apiBase: "http://127.0.0.1:4141/",
      sessionId: "session_one",
      text: "Retry me",
    }
    const first = await reserveAdmission(storage, draft, () => "request_first")

    await acknowledgeAdmission(storage, {
      ...first,
      requestId: "request_stale",
    })
    expect(
      await reserveAdmission(storage, draft, () => "request_second"),
    ).toEqual(first)

    await acknowledgeAdmission(storage, first)
    expect(
      await reserveAdmission(storage, draft, () => "request_second"),
    ).toEqual({
      ...draft,
      requestId: "request_second",
    })
  })

  it("replaces a malformed stored request id before sending", async () => {
    const storage = createMemoryStorage()
    const draft = {
      apiBase: "http://127.0.0.1:4141/",
      sessionId: "session_one",
      text: "Recover storage",
    }
    await reserveAdmission(storage, draft, () => "not a request id")

    expect(
      await reserveAdmission(storage, draft, () => "request_valid"),
    ).toEqual({
      ...draft,
      requestId: "request_valid",
    })
  })

  it("normalizes equivalent API base URLs", async () => {
    const storage = createMemoryStorage()
    const first = await reserveAdmission(
      storage,
      {
        apiBase: "HTTP://LOCALHOST:80/api?ignored=yes#fragment",
        sessionId: "session_one",
        text: "Same endpoint",
      },
      () => "request_first",
    )
    const equivalent = await reserveAdmission(
      storage,
      {
        apiBase: "http://localhost/api/",
        sessionId: "session_one",
        text: "Same endpoint",
      },
      () => "request_second",
    )

    expect(normalizeApiBase(first.apiBase)).toBe("http://localhost/api/")
    expect(equivalent).toEqual(first)
  })
})

function createMemoryStorage(): AdmissionStorage & {
  readonly keys: () => string[]
} {
  const values = new Map<string, string>()
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    keys() {
      return [...values.keys()]
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

function requestIds(...values: string[]): () => string {
  return () => {
    const value = values.shift()
    if (value !== undefined) return value
    throw new Error("Missing test request id.")
  }
}
