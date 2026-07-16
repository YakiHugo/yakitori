import { describe, expect, it } from "vitest"
import {
  beginSessionSelection,
  clearSessionSelection,
  createSessionSelectionState,
  currentSessionSelection,
  isCurrentSessionSelection,
} from "../../src/gui/session-selection.ts"

describe("session selection", () => {
  it("invalidates an older selection when another session is selected", () => {
    const state = createSessionSelectionState()
    const first = beginSessionSelection(state, "session_one")
    const second = beginSessionSelection(state, "session_two")

    expect(isCurrentSessionSelection(state, first)).toBe(false)
    expect(isCurrentSessionSelection(state, second)).toBe(true)
    expect(currentSessionSelection(state)).toEqual(second)
  })

  it("invalidates an older request even when the same session is reselected", () => {
    const state = createSessionSelectionState()
    const first = beginSessionSelection(state, "session_one")
    beginSessionSelection(state, "session_two")
    const latest = beginSessionSelection(state, "session_one")

    expect(isCurrentSessionSelection(state, first)).toBe(false)
    expect(isCurrentSessionSelection(state, latest)).toBe(true)
  })

  it("invalidates the active selection when it is cleared", () => {
    const state = createSessionSelectionState()
    const selected = beginSessionSelection(state, "session_one")

    clearSessionSelection(state)

    expect(isCurrentSessionSelection(state, selected)).toBe(false)
    expect(currentSessionSelection(state)).toBeUndefined()
  })
})
