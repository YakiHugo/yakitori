import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createPortal } from "react-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChatInterrupt } from "../../src/gui/hooks/use-chat-interrupt.ts"

function Conversation({
  name = "main",
  turnId = "turn",
  stopping = false,
  onInterrupt,
}: {
  name?: string
  turnId?: string
  stopping?: boolean
  onInterrupt(): void
}) {
  const events = useChatInterrupt({
    sessionId: name,
    turnId,
    stopping,
    onInterrupt,
  })
  return (
    <section {...events}>
      <input aria-label={name} />
      {createPortal(<input aria-label={`${name} portal`} />, document.body)}
    </section>
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("focused conversation interrupt", () => {
  it("routes only from the focused scope, not editor/browser siblings or portals", async () => {
    const main = vi.fn()
    const side = vi.fn()
    render(
      <>
        <Conversation onInterrupt={main} />
        <Conversation name="side" onInterrupt={side} />
        <input aria-label="file editor" />
      </>,
    )
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("file editor"), { key: "Escape" })
      fireEvent.keyDown(screen.getByLabelText("main portal"), { key: "Escape" })
      fireEvent.keyDown(window, { key: "Escape" })
    })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(main).not.toHaveBeenCalled()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(side).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText("side"), { key: "Escape" }),
    )
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(side).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(main).not.toHaveBeenCalled()
  })

  it.each([
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ])("ignores composing, held and modified Escape: %j", async (extra) => {
    const interrupt = vi.fn()
    render(<Conversation onInterrupt={interrupt} />)
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText("main"), {
        key: "Escape",
        ...extra,
      }),
    )
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it("keeps IME composition ownership even when the key event omits isComposing", async () => {
    const interrupt = vi.fn()
    render(<Conversation onInterrupt={interrupt} />)
    const input = screen.getByLabelText("main")
    fireEvent.compositionStart(input)
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it("lets later document and window dismiss handlers consume the event", async () => {
    const interrupt = vi.fn()
    render(<Conversation onInterrupt={interrupt} />)
    const dismiss = (event: KeyboardEvent) => event.preventDefault()
    for (const target of [document, window]) {
      target.addEventListener("keydown", dismiss as EventListener)
      try {
        await act(async () =>
          fireEvent.keyDown(screen.getByLabelText("main"), { key: "Escape" }),
        )
        await act(async () => {
          await vi.runOnlyPendingTimersAsync()
        })
        expect(interrupt).not.toHaveBeenCalled()
      } finally {
        target.removeEventListener("keydown", dismiss as EventListener)
      }
    }
  })

  it("does not retarget a finished turn, navigation, or unmounted conversation", async () => {
    const interrupt = vi.fn()
    const view = render(<Conversation onInterrupt={interrupt} />)
    fireEvent.keyDown(screen.getByLabelText("main"), { key: "Escape" })
    view.rerender(
      <Conversation name="other" turnId="next" onInterrupt={interrupt} />,
    )
    await act(async () => {})
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText("other"), { key: "Escape" })
    view.unmount()
    await act(async () => {})
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it("does not interrupt while stopping or while a dialog owns Escape", async () => {
    const interrupt = vi.fn()
    const view = render(<Conversation stopping onInterrupt={interrupt} />)
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText("main"), { key: "Escape" }),
    )
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
    view.rerender(
      <>
        <Conversation onInterrupt={interrupt} />
        <dialog open>Permission</dialog>
      </>,
    )
    await act(async () =>
      fireEvent.keyDown(screen.getByLabelText("main"), { key: "Escape" }),
    )
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(interrupt).not.toHaveBeenCalled()
  })
})
