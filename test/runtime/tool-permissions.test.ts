import { describe, expect, it } from "vitest"
import { resolveToolPermissionRequest } from "../../src/runtime/tool-permissions.ts"

describe("tool permission policy", () => {
  it("never requests approval for tools with no requirement", () => {
    expect(
      resolveToolPermissionRequest({ kind: "none" }, "auto_file_tools"),
    ).toBeUndefined()
  })

  it("bypasses every approval requirement in YOLO mode", () => {
    expect(
      resolveToolPermissionRequest(
        { kind: "approval", action: "command_execution" },
        "never",
      ),
    ).toBeUndefined()
    expect(
      resolveToolPermissionRequest(
        { kind: "approval", action: "file_change" },
        "never",
      ),
    ).toBeUndefined()
  })

  it("auto-allows file changes and requests command approval", () => {
    expect(
      resolveToolPermissionRequest(
        {
          kind: "approval",
          action: "file_change",
          subject: "src/a.ts",
        },
        "auto_file_tools",
      ),
    ).toBeUndefined()
    expect(
      resolveToolPermissionRequest(
        {
          kind: "approval",
          action: "command_execution",
          subject: "git status",
          reason: "host authority",
        },
        "auto_file_tools",
      ),
    ).toEqual({
      kind: "tool",
      action: "command_execution",
      subject: "git status",
      reason: "host authority",
    })
  })

  it("rejects an unknown persisted approval policy", () => {
    expect(() =>
      resolveToolPermissionRequest({ kind: "none" }, "future_policy"),
    ).toThrow("Unsupported approval policy: future_policy")
    expect(() =>
      resolveToolPermissionRequest(
        { kind: "approval", action: "command_execution" },
        "future_policy",
      ),
    ).toThrow("Unsupported approval policy: future_policy")
  })
})
