/** Escape dismissal and interruption share the same physical-key boundary. */
export function isUnmodifiedEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}
