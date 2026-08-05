// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { ToolCell } from "../../src/gui/components/cells/tool-cell.tsx"

afterEach(() => {
  cleanup()
})

describe("tool cell", () => {
  it("collapses to one row and expands to show input and output", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={{
          kind: "tool",
          toolCallId: "tool_1",
          turnId: "turn_1",
          name: "read_file",
          summary: "src/index.ts",
          input: { path: "src/index.ts" },
          state: "completed",
          resultText: "file contents",
        }}
      />,
    )

    expect(screen.queryByText("file contents")).toBeNull()
    expect(screen.queryByText(/"path"/)).toBeNull()

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText("file contents")).toBeTruthy()
    expect(screen.getByText(/"path"/)).toBeTruthy()
  })

  it("renders run_command entries as a terminal card when expanded", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={{
          kind: "tool",
          toolCallId: "tool_2",
          turnId: "turn_1",
          name: "run_command",
          summary: "pnpm test",
          input: { command: "pnpm test" },
          state: "completed",
          resultText: "all green",
        }}
      />,
    )

    expect(screen.queryByText(/\$ pnpm test/)).toBeNull()

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText(/\$ pnpm test/)).toBeTruthy()
    expect(screen.getByText(/all green/)).toBeTruthy()
  })

  it("renders a structured command result with exit status and stderr", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={{
          kind: "tool",
          toolCallId: "tool_3",
          turnId: "turn_1",
          name: "run_command",
          summary: "pnpm lint",
          input: { command: "pnpm lint" },
          state: "failed",
          resultText: "lint failed",
          commandResult: {
            exitCode: 1,
            signal: null,
            stdout: "checking…",
            stderr: "2 errors",
            truncated: false,
            timedOut: false,
          },
        }}
      />,
    )

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText(/\$ pnpm lint/)).toBeTruthy()
    expect(screen.getByText(/checking…/)).toBeTruthy()
    expect(screen.getByText(/\[stderr\]/)).toBeTruthy()
    expect(screen.getByText("exit 1")).toBeTruthy()
  })

  it("renders a diff view instead of raw input for edit_file results", async () => {
    const user = userEvent.setup()
    render(
      <ToolCell
        entry={{
          kind: "tool",
          toolCallId: "tool_4",
          turnId: "turn_1",
          name: "edit_file",
          summary: "src/index.ts",
          input: { path: "src/index.ts", oldString: "old", newString: "new" },
          state: "completed",
          resultText: "edited src/index.ts",
          diff: {
            text: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
            truncated: false,
          },
        }}
      />,
    )

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText("-old")).toBeTruthy()
    expect(screen.getByText("+new")).toBeTruthy()
    expect(screen.queryByText(/"oldString"/)).toBeNull()
  })
})
