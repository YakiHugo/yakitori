export type SessionSelectionState = {
  revision: number
  sessionId?: string
}

export type SessionSelection = {
  readonly revision: number
  readonly sessionId: string
}

export function createSessionSelectionState(): SessionSelectionState {
  return {
    revision: 0,
  }
}

export function beginSessionSelection(
  state: SessionSelectionState,
  sessionId: string,
): SessionSelection {
  state.revision += 1
  state.sessionId = sessionId
  return {
    revision: state.revision,
    sessionId,
  }
}

export function clearSessionSelection(state: SessionSelectionState): void {
  state.revision += 1
  delete state.sessionId
}

export function currentSessionSelection(
  state: SessionSelectionState,
): SessionSelection | undefined {
  if (state.sessionId === undefined) return
  return {
    revision: state.revision,
    sessionId: state.sessionId,
  }
}

export function isCurrentSessionSelection(
  state: SessionSelectionState,
  selection: SessionSelection,
): boolean {
  return (
    state.revision === selection.revision &&
    state.sessionId === selection.sessionId
  )
}
