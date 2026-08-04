import { describe, expect, it } from "vitest"
import {
  createFileObservationStore,
  ToolState,
  type ToolProjection,
} from "../../../src/index.ts"

describe("file observations", () => {
  it("rebuilds the latest revision from recorded successful tool results", () => {
    const tools: ToolProjection[] = [
      toolProjection("read_file", {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: true,
        range: { offset: 1, requestedLimit: 20 },
        content: "",
      }),
      toolProjection("edit_file", {
        path: "src/value.ts",
        sha256: "b".repeat(64),
      }),
    ]
    const rebuilt = createFileObservationStore(tools)
    expect(rebuilt.latest("src/value.ts")).toEqual({
      sha256: "b".repeat(64),
      complete: false,
      observation: "edit",
    })
    rebuilt.recordSuccess(
      "write_file",
      { path: "new.ts" },
      {
        path: "new.ts",
        sha256: "c".repeat(64),
        created: true,
      },
    )
    expect(rebuilt.latest("new.ts")).toEqual({
      sha256: "c".repeat(64),
      complete: true,
      observation: "write",
    })
  })

  it("ignores legacy grep observations and distinguishes ranged and whole reads", () => {
    const store = createFileObservationStore()
    store.recordSuccess(
      "grep",
      {},
      {
        observations: [
          {
            path: "src/value.ts",
            sha256: "a".repeat(64),
            kind: "grep_snippet",
            ranges: [{ startLine: 7, endLine: 9 }],
          },
        ],
      },
    )
    expect(store.latest("src/value.ts")).toBeUndefined()

    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: true,
        range: { offset: 1, limit: 20, requestedLimit: 20 },
      },
    )
    expect(store.latest("src/value.ts")).toMatchObject({
      complete: false,
      observation: "ranged_read",
    })

    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: false,
        range: { offset: 1, limit: 200, requestedLimit: 200 },
      },
    )
    expect(store.latest("src/value.ts")).toMatchObject({
      complete: true,
      observation: "whole_file_read",
    })
    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: true,
        range: { offset: 50, limit: 10, requestedLimit: 10 },
      },
    )
    expect(store.latest("src/value.ts")).toMatchObject({
      complete: true,
      observation: "whole_file_read",
    })
  })

  it("keeps read continuation revisions inside the observation state", () => {
    const store = createFileObservationStore()
    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: true,
        range: { offset: 1, requestedLimit: 20 },
        continuation: { nextOffset: 21 },
      },
    )
    expect(store.continuationSha("src/value.ts", 21)).toBe("a".repeat(64))
    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: true,
        range: { offset: 21, requestedLimit: 20 },
        continuation: { nextOffset: 41 },
      },
    )
    expect(store.continuationSha("src/value.ts", 21)).toBeUndefined()
    expect(store.continuationSha("src/value.ts", 41)).toBe("a".repeat(64))

    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "b".repeat(64),
        truncated: false,
        range: { offset: 1, requestedLimit: 20 },
      },
    )
    expect(store.continuationSha("src/value.ts", 21)).toBeUndefined()
  })

  it("does not treat a suffix read through EOF as a complete observation", () => {
    const store = createFileObservationStore()
    store.recordSuccess(
      "read_file",
      {},
      {
        path: "src/value.ts",
        sha256: "a".repeat(64),
        truncated: false,
        range: { offset: 100, limit: 20, requestedLimit: 20 },
      },
    )

    expect(store.latest("src/value.ts")).toEqual({
      sha256: "a".repeat(64),
      complete: false,
      observation: "ranged_read",
      ranges: [{ startLine: 100, endLine: 119 }],
    })
  })
})

function toolProjection(
  name: string,
  output: Exclude<ToolProjection["output"], undefined>,
): ToolProjection {
  return {
    toolCallId: `tool_${name}`,
    turnId: "turn_1",
    name,
    input: {},
    state: ToolState.Completed,
    requestedAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    requestItemId: `item_${name}`,
    requiresPermission: false,
    output,
  }
}
