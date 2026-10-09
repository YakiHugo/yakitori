import type { EngineSessionSnapshot } from "../protocol/engine.ts"

// This is an observed app transcript, not an imported copy of an engine's
// private context. Terminal statuses, rather than cancel acknowledgements,
// release the composer.
export function projectEngineSession(snapshot: EngineSessionSnapshot) {
  const turns = new Map<
    string,
    {
      id: string
      input: string
      assistant: string
      reasoning: string
      updates: Record<string, unknown>[]
      status?: string
    }
  >()
  const permissions = new Map<
    string,
    Extract<
      EngineSessionSnapshot["events"][number]["event"],
      { type: "permission.requested" }
    >
  >()
  let activeTurnId: string | undefined
  for (const { event } of snapshot.events) {
    if (event.type === "permission.resolved") {
      permissions.delete(event.requestId)
      continue
    }
    if (!("turnId" in event) || event.turnId === undefined) continue
    let turn = turns.get(event.turnId)
    if (turn === undefined) {
      turn = {
        id: event.turnId,
        input: "",
        assistant: "",
        reasoning: "",
        updates: [],
      }
      turns.set(event.turnId, turn)
    }
    if (
      event.type === "session.update" &&
      !event.replayed &&
      event.update.sessionUpdate !== "agent_message_chunk" &&
      event.update.sessionUpdate !== "agent_thought_chunk"
    )
      turn.updates.push(event.update)
    if (event.type === "input.submitted") turn.input = event.text
    if (event.type === "message.delta") turn[event.channel] += event.text
    if (event.type === "permission.requested")
      permissions.set(event.requestId, event)
    if (event.type === "turn.status") {
      turn.status = event.message ?? event.status
      if (event.status === "running" || event.status === "accepted")
        activeTurnId = event.turnId
      else {
        if (activeTurnId === event.turnId) activeTurnId = undefined
        for (const [id, permission] of permissions) {
          if (permission.turnId === event.turnId) permissions.delete(id)
        }
      }
    }
  }
  const uncertain = snapshot.requests.filter(
    (request) => request.status === "unknown" || request.status === "pending",
  )
  return {
    turns: [...turns.values()],
    permissions: [...permissions.values()],
    activeTurnId,
    uncertain,
  }
}
