// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pastePrompt } from "./prompt-editor-helpers.ts"
import { UserMessageCell } from "../../src/gui/components/cells/user-message-cell.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

const entry = {
  kind: "user_input" as const,
  inputId: "input_1",
  text: "Original request",
  at: "2026-08-17T00:00:00.000Z",
}

describe("attachments", () => {
  const image = {
    name: "screenshot.png",
    mediaType: "image/png" as const,
    detail: "high" as const,
    sizeBytes: 9,
    file: {
      rolloutId: "session_1",
      path: "attachments/staging/draft_1/1.png",
    },
  }

  it("opens a zoomable preview when an image attachment is clicked", async () => {
    const user = userEvent.setup()
    render(
      <UserMessageCell
        entry={{ ...entry, attachments: [image] }}
        queued={false}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: "Preview screenshot.png" }),
    )
    const dialog = screen.getByRole("dialog", {
      name: "Preview screenshot.png",
    })
    expect(dialog.textContent).toContain("100%")
    await user.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(dialog.textContent).toContain("125%")
    await user.click(screen.getByRole("button", { name: "Close preview" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("skill mentions", () => {
  it("renders trailing skill mentions as chips and strips them from the text", () => {
    render(
      <UserMessageCell
        entry={{
          ...entry,
          text: "Use this please [$Template Creator](/repo/.agents/skills/template/SKILL.md)",
        }}
        queued={false}
      />,
    )

    expect(screen.getByText("$Template Creator")).toBeDefined()
    expect(screen.getByText("Use this please")).toBeDefined()
    expect(screen.queryByText(/SKILL\.md/)).toBeNull()
  })
})

describe("user message fork actions", () => {
  it("confirms conversation-only undo before creating a branch", async () => {
    const user = userEvent.setup()
    const forkSession = vi.fn(async () => {})
    useAppStore.setState({ forkSession })
    render(<UserMessageCell entry={entry} queued={false} />)

    await user.click(screen.getByRole("button", { name: "Undo to here" }))
    expect(
      screen.getByText(/Files and command effects stay as-is/),
    ).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Undo" }))

    expect(forkSession).toHaveBeenCalledWith("input_1", "undo")
  })

  it("edits and resubmits the message in a new branch", async () => {
    const user = userEvent.setup()
    const forkSession = vi.fn(async () => {})
    useAppStore.setState({ forkSession })
    render(<UserMessageCell entry={entry} queued={false} />)

    await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
    const editor = screen.getByRole("textbox", { name: "Edit message" })
    await pastePrompt(editor, "Replacement request", true)
    await user.click(screen.getByRole("button", { name: "Send" }))

    expect(forkSession).toHaveBeenCalledWith(
      "input_1",
      "edit",
      "Replacement request",
    )
  })

  it("disables fork actions and edit controls while the session is busy", async () => {
    const user = userEvent.setup()
    const forkSession = vi.fn(async () => {})
    useAppStore.setState({ busy: true, forkSession })
    render(<UserMessageCell entry={entry} queued={false} />)

    expect(
      screen.getByRole("button", { name: "Edit & resubmit" }),
    ).toHaveProperty("disabled", true)
    expect(screen.getByRole("button", { name: "Undo to here" })).toHaveProperty(
      "disabled",
      true,
    )

    act(() => useAppStore.setState({ busy: false }))
    await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
    act(() => useAppStore.setState({ busy: true }))

    expect(
      screen
        .getByRole("textbox", { name: "Edit message" })
        .getAttribute("aria-disabled"),
    ).toBe("true")
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    )
    await user.keyboard("{Enter}")
    expect(forkSession).not.toHaveBeenCalled()
  })

  it("dismisses the undo confirmation without forking", async () => {
    const user = userEvent.setup()
    const forkSession = vi.fn(async () => {})
    useAppStore.setState({ forkSession })
    render(<UserMessageCell entry={entry} queued={false} />)

    await user.click(screen.getByRole("button", { name: "Undo to here" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      screen.queryByText(/Files and command effects stay as-is/),
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Undo to here" })).toBeDefined()
    expect(forkSession).not.toHaveBeenCalled()
  })

  it("blocks submitting an emptied edit unless attachments remain", async () => {
    const user = userEvent.setup()
    const forkSession = vi.fn(async () => {})
    useAppStore.setState({ forkSession })
    render(<UserMessageCell entry={entry} queued={false} />)

    await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
    const editor = screen.getByRole("textbox", { name: "Edit message" })
    await pastePrompt(editor, " ", true)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
    await user.keyboard("{Enter}")
    expect(forkSession).not.toHaveBeenCalled()
  })
})

it("edits in place, cancels with Escape and preserves skill mentions when sending", async () => {
  const user = userEvent.setup()
  const forkSession = vi.fn(async () => {})
  useAppStore.setState({ forkSession })
  render(
    <UserMessageCell
      entry={{
        ...entry,
        text: "Original request [$review](/skills/review/SKILL.md)",
      }}
      queued={false}
    />,
  )
  await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
  let editor = screen.getByRole("textbox", { name: "Edit message" })
  expect(document.activeElement).toBe(editor)
  expect(editor.textContent).toBe("Original request $review")
  await user.keyboard("{Escape}")
  expect(screen.getByText("Original request")).toBeDefined()
  expect(forkSession).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
  editor = screen.getByRole("textbox", { name: "Edit message" })
  await pastePrompt(
    editor,
    "Updated request [$review](/skills/review/SKILL.md)",
    true,
  )
  await user.keyboard("{Enter}")
  expect(forkSession).toHaveBeenCalledWith(
    "input_1",
    "edit",
    "Updated request [$review](/skills/review/SKILL.md)",
  )
})

it("keeps the edited draft until the replacement conversation is activated", async () => {
  const user = userEvent.setup()
  useAppStore.setState({ forkSession: vi.fn(async () => {}) })
  render(<UserMessageCell entry={entry} queued={false} />)
  await user.click(screen.getByRole("button", { name: "Edit & resubmit" }))
  await pastePrompt(
    screen.getByRole("textbox", { name: "Edit message" }),
    "Keep this draft",
    true,
  )
  await user.keyboard("{Enter}")
  expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveProperty(
    "textContent",
    "Keep this draft",
  )
})
