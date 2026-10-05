import { describe, expect, it } from "vitest"
import {
  createVisibleFileObservations,
  createVisibleFileObservationsFromMessages,
  grantsFromToolOutput,
} from "../../../src/runtime/tools/visible-file-observations.ts"

describe("visible file observations", () => {
  it("restores only explicit grants from the model's visible messages", () => {
    const visible = createVisibleFileObservationsFromMessages([
      {
        role: "tool",
        toolCallId: "read",
        content: [{ type: "text", text: "read contents" }],
        fileObservations: [
          {
            path: "src/value.ts",
            kind: "whole_file_read",
            complete: true,
            sha256: "a".repeat(64),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "edit",
        content: [{ type: "text", text: "edited contents" }],
        fileObservations: [
          {
            path: "src/value.ts",
            kind: "edit",
            complete: false,
            sha256: "b".repeat(64),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "hidden",
        content: [{ type: "text", text: "no grant" }],
      },
    ])
    expect(visible.latest("src/value.ts")).toEqual({
      sha256: "b".repeat(64),
      complete: true,
      observation: "edit",
    })
    const withoutVisibleBase = createVisibleFileObservations()
    withoutVisibleBase.apply({
      path: "src/value.ts",
      kind: "edit",
      complete: false,
      sha256: "b".repeat(64),
    })
    expect(withoutVisibleBase.latest("src/value.ts")).toBeUndefined()
  })

  it("treats whole-file writes and edit creations as authorship", () => {
    const visible = createVisibleFileObservations()
    visible.apply({
      path: "created-by-edit.ts",
      kind: "edit",
      complete: false,
      created: true,
      sha256: "d".repeat(64),
    })
    visible.apply({
      path: "new.ts",
      kind: "write",
      complete: true,
      sha256: "c".repeat(64),
    })
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

  it("keeps ranged reads revisionless and merges their visible lines", () => {
    const visible = createVisibleFileObservations()
    visible.apply({
      path: "src/value.ts",
      kind: "ranged_read",
      complete: false,
      ranges: [{ startLine: 1, endLine: 20 }],
    })
    visible.apply({
      path: "src/value.ts",
      kind: "ranged_read",
      complete: false,
      ranges: [{ startLine: 21, endLine: 30 }],
    })
    expect(visible.latest("src/value.ts")).toEqual({
      complete: false,
      observation: "ranged_read",
      ranges: [{ startLine: 1, endLine: 30 }],
    })
  })

  it("keeps a complete revision when a later live page is applied", () => {
    const visible = createVisibleFileObservations()
    visible.apply({
      path: "src/value.ts",
      kind: "whole_file_read",
      complete: true,
      sha256: "a".repeat(64),
    })
    visible.apply({
      path: "src/value.ts",
      kind: "ranged_read",
      complete: false,
      ranges: [{ startLine: 100, endLine: 119 }],
    })
    expect(visible.latest("src/value.ts")).toEqual({
      sha256: "a".repeat(64),
      complete: true,
      observation: "whole_file_read",
      ranges: [{ startLine: 100, endLine: 119 }],
    })
  })

  it("does not grant file authorship from unstructured or invalid tool output", () => {
    expect(
      grantsFromToolOutput({
        path: "src/value.ts",
        complete: true,
        sha256: "a".repeat(64),
      }),
    ).toEqual([])
    expect(
      grantsFromToolOutput({
        path: "src/value.ts",
        complete: true,
        sha256: "a".repeat(64),
        fileObservation: { kind: "not-a-grant" },
      }),
    ).toEqual([])
  })

  it("extracts every explicit revision emitted by a multi-file patch", () => {
    expect(
      grantsFromToolOutput({
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
    ).toEqual([
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
    ])
  })

  it("restores plural message grants and applies deletion tombstones", () => {
    const visible = createVisibleFileObservationsFromMessages([
      {
        role: "tool",
        toolCallId: "patch",
        content: [{ type: "text", text: "done" }],
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
    const visible = createVisibleFileObservations()
    visible.apply({
      path: "destination.txt",
      kind: "write",
      complete: true,
      sha256: "a".repeat(64),
    })
    visible.apply({
      path: "destination.txt",
      kind: "invalidate",
      complete: true,
    })
    expect(visible.latest("destination.txt")).toBeUndefined()
  })
})
