// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../../src/gui/components/composer.tsx"
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

describe("composer", () => {
  it("sends the trimmed draft on Enter", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "  hello mate  ",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("{Enter}")

    expect(admitInput).toHaveBeenCalledTimes(1)
    expect(admitInput).toHaveBeenCalledWith("hello mate")
  })

  it("does not send on Shift+Enter", async () => {
    const user = userEvent.setup()
    const admitInput = vi.fn((_text: string) => Promise.resolve())
    useAppStore.setState({
      admitInput,
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "hello",
    })
    render(<Composer />)

    const textarea = screen.getByRole("textbox")
    await user.click(textarea)
    await user.keyboard("{Shift>}{Enter}{/Shift}")

    expect(admitInput).not.toHaveBeenCalled()
  })

  it("keeps the send button disabled for an empty draft", () => {
    useAppStore.setState({
      selection: { revision: 1, sessionId: "session_1" },
      promptDraft: "   ",
    })
    render(<Composer />)

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      true,
    )
  })
})
