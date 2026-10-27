import { type KeyboardEvent, useLayoutEffect, useRef } from "react"
import { isUnmodifiedEscape } from "../lib/escape-key.ts"

/** Escape belongs to the focused conversation, after its dismissible surfaces. */
export function useChatInterrupt({
  sessionId,
  turnId,
  stopping,
  onInterrupt,
}: {
  sessionId: string | undefined
  turnId: string | undefined
  stopping: boolean
  onInterrupt(): void
}) {
  const composing = useRef<EventTarget | null>(null)
  const current = useRef({ sessionId, turnId, stopping, onInterrupt })
  useLayoutEffect(() => {
    current.current = { sessionId, turnId, stopping, onInterrupt }
    return () => {
      current.current = { ...current.current, turnId: undefined }
    }
  }, [sessionId, turnId, stopping, onInterrupt])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const native = event.nativeEvent
    const scope = event.currentTarget
    const target = event.target
    const captured = current.current
    if (
      !isUnmodifiedEscape(native) ||
      (composing.current instanceof Node &&
        scope.contains(composing.current)) ||
      captured.sessionId === undefined ||
      captured.turnId === undefined ||
      captured.stopping ||
      !(target instanceof Node) ||
      !scope.contains(target) ||
      document.querySelector("dialog[open]")
    )
      return

    // Document/window dismiss handlers run after React's delegated bubbling.
    // A microtask can run between native listeners in a browser, so defer a task.
    // Preserve the addressed turn rather than resolving a new one after them.
    setTimeout(() => {
      const latest = current.current
      if (
        native.defaultPrevented ||
        !scope.isConnected ||
        latest.sessionId !== captured.sessionId ||
        latest.turnId !== captured.turnId ||
        latest.stopping
      )
        return
      latest.onInterrupt()
    }, 0)
  }
  return {
    onKeyDown,
    onCompositionStartCapture: (event: { target: EventTarget }) => {
      composing.current = event.target
    },
    onCompositionEndCapture: () => {
      composing.current = null
    },
  }
}
