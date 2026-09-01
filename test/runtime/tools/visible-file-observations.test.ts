import { describe, expect, it } from "vitest"
import {
  createVisibleFileObservations,
  createVisibleFileObservationsFromMessages,
  type StoredToolObservation,
} from "../../../src/runtime/tools/visible-file-observations.ts"

describe("visible file observations", () => {
  it("projects only the successful tool results supplied for one model request", () => {
    const visible = createVisibleFileObservations([
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: true,
        sha256: "a".repeat(64),
        range: { offset: 1, limit: 20, requestedLimit: 20 },
      }),
      toolProjection("edit_file", {
        path: "src/value.ts",
        sha256: "b".repeat(64),
        optimisticRebase: false,
      }),
    ])
    expect(visible.latest("src/value.ts")).toEqual({
      sha256: "b".repeat(64),
      complete: true,
      observation: "edit",
    })

    const editWithoutVisibleBase = createVisibleFileObservations([
      toolProjection("edit_file", {
        path: "src/value.ts",
        sha256: "b".repeat(64),
      }),
    ])
    expect(editWithoutVisibleBase.latest("src/value.ts")).toBeUndefined()
  })

  it("treats visible whole-file writes and edit creations as authorship", () => {
    const visible = createVisibleFileObservations([
      toolProjection("edit_file", {
        path: "created-by-edit.ts",
        sha256: "d".repeat(64),
        created: true,
      }),
      toolProjection("write_file", {
        path: "new.ts",
        sha256: "c".repeat(64),
        created: true,
      }),
    ])
    expect(visible.latest("created-by-edit.ts")).toEqual({
      sha256: "d".repeat(64),
      complete: true,
      observation: "edit",
    })
    expect(visible.latest("new.ts")).toEqual({
      sha256: "c".repeat(64),
      complete: true,
      observation: "write",
    })
  })

  it("keeps live ranged reads revisionless and merges their visible lines", () => {
    const visible = createVisibleFileObservations([
      toolProjection("grep", {
        observations: [
          {
            path: "src/value.ts",
            sha256: "a".repeat(64),
            kind: "grep_snippet",
            ranges: [{ startLine: 7, endLine: 9 }],
          },
        ],
      }),
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: false,
        range: { offset: 1, limit: 20, requestedLimit: 20 },
      }),
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: false,
        range: { offset: 21, limit: 10, requestedLimit: 10 },
      }),
    ])

    expect(visible.latest("src/value.ts")).toEqual({
      complete: false,
      observation: "ranged_read",
      ranges: [{ startLine: 1, endLine: 30 }],
    })
  })

  it("keeps a complete revision when a later live page is applied", () => {
    const complete = toolProjection("read_file", {
      path: "src/value.ts",
      complete: true,
      sha256: "a".repeat(64),
      range: { offset: 1, limit: 20, requestedLimit: 20 },
    })
    expect(
      createVisibleFileObservations([complete]).latest("src/value.ts"),
    ).toEqual({
      sha256: "a".repeat(64),
      complete: true,
      observation: "whole_file_read",
    })

    const stillComplete = createVisibleFileObservations([
      complete,
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: false,
        range: { offset: 100, limit: 20, requestedLimit: 20 },
      }),
    ])
    expect(stillComplete.latest("src/value.ts")).toEqual({
      sha256: "a".repeat(64),
      complete: true,
      observation: "whole_file_read",
      ranges: [{ startLine: 100, endLine: 119 }],
    })
  })

  it("does not infer a legacy grant when fileObservation is present but invalid", () => {
    const visible = createVisibleFileObservations([
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: true,
        sha256: "a".repeat(64),
        range: { offset: 1, limit: 20, requestedLimit: 20 },
        fileObservation: { kind: "not-a-grant" },
      }),
    ])
    expect(visible.latest("src/value.ts")).toBeUndefined()
  })

  it("applies a later edit grant without requiring a sibling read", () => {
    const visible = createVisibleFileObservations([
      toolProjection("read_file", {
        path: "src/value.ts",
        complete: true,
        sha256: "a".repeat(64),
      }),
    ])
    visible.apply({
      path: "src/value.ts",
      kind: "edit",
      complete: false,
      sha256: "b".repeat(64),
    })
    expect(visible.latest("src/value.ts")).toEqual({
      sha256: "b".repeat(64),
      complete: true,
      observation: "edit",
    })
  })

  it("restores every file revision emitted by a multi-file patch", () => {
    const visible = createVisibleFileObservations([
      toolProjection("apply_patch", {
        fileObservations: [
          {
            path: "src/a.ts",
            kind: "write",
            complete: true,
            created: true,
            sha256: "a".repeat(64),
          },
          {
            path: "src/b.ts",
            kind: "edit",
            complete: true,
            sha256: "b".repeat(64),
          },
        ],
      }),
    ])

    expect(visible.latest("src/a.ts")).toMatchObject({
      sha256: "a".repeat(64),
      complete: true,
    })
    expect(visible.latest("src/b.ts")).toMatchObject({
      sha256: "b".repeat(64),
      complete: true,
    })
  })

  it("restores plural message grants and applies deletion tombstones", () => {
    const visible = createVisibleFileObservationsFromMessages([
      {
        role: "tool",
        toolCallId: "patch",
        content: "done",
        fileObservations: [
          {
            path: "src/a.ts",
            kind: "write",
            complete: true,
            sha256: "a".repeat(64),
          },
          {
            path: "src/b.ts",
            kind: "write",
            complete: true,
            sha256: "b".repeat(64),
          },
          { path: "src/a.ts", kind: "delete", complete: true },
        ],
      },
    ])

    expect(visible.latest("src/a.ts")).toBeUndefined()
    expect(visible.latest("src/b.ts")).toMatchObject({
      sha256: "b".repeat(64),
      complete: true,
    })
  })

  it("invalidates a revision when a patch delta is not exact", () => {
    const visible = createVisibleFileObservations([
      toolProjection("write_file", {
        path: "destination.txt",
        sha256: "a".repeat(64),
        created: true,
      }),
    ])

    visible.apply({
      path: "destination.txt",
      kind: "invalidate",
      complete: true,
    })
    expect(visible.latest("destination.txt")).toBeUndefined()
  })
})

function toolProjection(
  name: string,
  output: Exclude<StoredToolObservation["output"], undefined>,
): StoredToolObservation {
  return {
    name,
    state: "completed",
    output,
  }
}
