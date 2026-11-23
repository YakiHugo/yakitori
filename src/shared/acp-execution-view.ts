import type {
  EngineEvent,
  EnginePromptCapabilities,
  EngineSessionSnapshot,
} from "../protocol/engine.ts"
import type {
  CitationSource,
  ExecutionEntry,
  ExecutionView,
  ReplayedInputPart,
  TurnTiming,
} from "../protocol/execution-view.ts"
import { createUserInput } from "../protocol/user-input.ts"
import type { SessionPlan } from "../protocol/user-interaction.ts"
import {
  acpMessageContent,
  acpRecord,
  acpString,
} from "./acp-message-content.ts"
import { type AcpToolEntry, projectAcpTool } from "./acp-tool-activity.ts"
import {
  createExecutionViewState,
  projectExecutionView,
} from "./execution-view.ts"

type ObservedEvent = EngineSessionSnapshot["events"][number]
type Permission = Extract<EngineEvent, { type: "permission.requested" }>
type TextEntry = Extract<ExecutionEntry, { kind: "assistant" | "reasoning" }>
type Turn = {
  id: string
  startedAt: string
  completedAt?: string
  input?: Extract<ExecutionEntry, { kind: "user_input" }>
  inputMessageId?: string
  entries: ExecutionEntry[]
  openText?: number
}

export function projectEngineSession(snapshot: EngineSessionSnapshot) {
  let controls: readonly AcpConfigControl[] = []
  let commands: { name: string; description: string }[] = []
  let usage: { used: number; size: number } | undefined
  let prompt: EnginePromptCapabilities | undefined
  for (const { event } of snapshot.events) {
    if (event.type !== "session.update") continue
    const { update } = event
    controls = applyAcpConfig(controls, update)
    if (
      update.sessionUpdate === "session_initialized" &&
      update.promptCapabilities !== undefined
    ) {
      const capabilities = acpRecord(update.promptCapabilities)
      prompt = {
        ...(capabilities.image === true ? { image: true } : {}),
        ...(capabilities.embeddedContext === true
          ? { embeddedContext: true }
          : {}),
      }
    }
    if (
      update.sessionUpdate === "available_commands_update" &&
      Array.isArray(update.availableCommands)
    )
      commands = update.availableCommands.flatMap((command) => {
        const { name, description } = acpRecord(command)
        return typeof name === "string" && /^[\p{L}\p{N}_-]+$/u.test(name)
          ? [
              {
                name: `/${name}`,
                description: typeof description === "string" ? description : "",
              },
            ]
          : []
      })
    if (
      update.sessionUpdate === "usage_update" &&
      typeof update.used === "number" &&
      Number.isSafeInteger(update.used) &&
      update.used >= 0 &&
      typeof update.size === "number" &&
      Number.isSafeInteger(update.size) &&
      update.size > 0
    )
      usage = { used: update.used, size: update.size }
  }
  const observed = projectObserved(
    snapshot.events.filter(
      ({ event }) => event.type !== "session.update" || !event.replayed,
    ),
  )
  // session/load sends the whole transcript again. Only the latest complete
  // batch is needed and locally observed turns have more detailed state.
  const latestReplay: ObservedEvent[] = []
  let collecting = false
  for (const envelope of snapshot.events) {
    const { event } = envelope
    if (event.type === "session.update" && event.replayed) {
      if (!collecting) latestReplay.length = 0
      latestReplay.push(envelope)
      collecting = true
    } else if (
      event.type === "session.update" &&
      event.update.sessionUpdate === "session_initialized"
    ) {
      collecting = false
    }
  }
  const replayed = projectObserved(latestReplay, true)
  const turns: Turn[] = []
  const liveTurns = [...observed.turns.values()]
  let liveIndex = 0
  for (const turn of replayed.turns.values()) {
    const key = turnIdentity(turn)
    const match =
      key === undefined && turn.inputMessageId === undefined
        ? -1
        : liveTurns.findIndex(
            (live, index) =>
              index >= liveIndex &&
              (turn.inputMessageId !== undefined &&
              live.inputMessageId !== undefined
                ? turn.inputMessageId === live.inputMessageId
                : key !== undefined && turnIdentity(live) === key),
          )
    if (match < 0) turns.push(turn)
    else {
      turns.push(...liveTurns.slice(liveIndex, match + 1))
      liveIndex = match + 1
    }
  }
  turns.push(...liveTurns.slice(liveIndex))
  const base = projectExecutionView(createExecutionViewState())
  const executionView: ExecutionView = {
    ...base,
    entries: turns.flatMap((turn) =>
      turn.input === undefined ? turn.entries : [turn.input, ...turn.entries],
    ),
    turnTimings: Object.fromEntries(
      turns.map((turn): [string, TurnTiming] => [
        turn.id,
        {
          startedAt: turn.startedAt,
          ...(turn.completedAt === undefined
            ? {}
            : { completedAt: turn.completedAt }),
          ...(turn.input === undefined ? {} : { inputId: turn.input.inputId }),
        },
      ]),
    ),
    ...(observed.activeTurnId === undefined
      ? {}
      : { activeTurnId: observed.activeTurnId }),
    workingDirectory: snapshot.session.cwd,
  }
  return {
    executionView,
    chrome: { controls, commands, usage, prompt },
    activeTurnId: observed.activeTurnId,
    permissions: [...observed.permissions.values()].map((permission) => ({
      ...permission,
      tool: observed.tools.get(
        acpString(permission.toolCall?.toolCallId) ?? permission.requestId,
      )?.entry,
    })),
    uncertain: snapshot.requests.filter(
      (request) => request.status === "unknown" || request.status === "pending",
    ),
  }
}

function turnIdentity(turn: Turn): string | undefined {
  if (turn.input === undefined) return undefined
  const text = turn.entries
    .flatMap((entry) => (entry.kind === "assistant" ? [entry.text] : []))
    .join("")
  return text === "" ? undefined : JSON.stringify([turn.input.text, text])
}

function projectObserved(events: readonly ObservedEvent[], replay = false) {
  const turns = new Map<string, Turn>()
  const tools = new Map<
    string,
    {
      wire: Record<string, unknown>
      turn: Turn
      index: number
      entry: AcpToolEntry
    }
  >()
  const permissions = new Map<string, Permission>()
  const permissionEntries = new Map<string, { turn: Turn; index: number }>()
  let activeTurnId: string | undefined
  let replayTurnId: string | undefined
  let replayChannel: string | undefined
  const turnFor = (id: string, at: string) => {
    const prior = turns.get(id)
    if (prior !== undefined) return prior
    const turn: Turn = { id, startedAt: at, entries: [] }
    turns.set(id, turn)
    return turn
  }
  const closeText = (turn: Turn, at: string) => {
    const index = turn.openText
    if (index === undefined) return
    delete turn.openText
    const entry = turn.entries[index]
    if (
      (entry?.kind !== "assistant" && entry?.kind !== "reasoning") ||
      entry.status !== "streaming"
    )
      return
    if (entry.kind === "reasoning" && entry.startedAt !== undefined) {
      // ACP provides chunks without an end timestamp. A new entry or the
      // terminal update closes the locally observed interval.
      turn.entries[index] = {
        ...entry,
        status: "completed",
        completedAt: at,
        durationMs: Math.max(0, Date.parse(at) - Date.parse(entry.startedAt)),
      }
    } else turn.entries[index] = { ...entry, status: "completed" }
  }
  const addText = (
    turn: Turn,
    kind: TextEntry["kind"],
    text: string,
    seq: number,
    at: string,
    source?: CitationSource,
  ) => {
    if (text.length === 0 && source === undefined) return
    const index = turn.openText
    const prior = index === undefined ? undefined : turn.entries[index]
    if (index !== undefined && prior?.kind === kind) {
      turn.entries[index] = {
        ...prior,
        text: prior.text + text,
        ...(prior.kind === "assistant" && source !== undefined
          ? { sources: [...(prior.sources ?? []), source] }
          : {}),
      }
      return
    }
    closeText(turn, at)
    turn.openText = turn.entries.length
    turn.entries.push({
      kind,
      itemId: `acp:text:${seq}`,
      turnId: turn.id,
      text,
      status:
        replay || turn.completedAt !== undefined ? "completed" : "streaming",
      at,
      ...(kind === "reasoning"
        ? {
            format: "raw",
            ...(replay || turn.completedAt !== undefined
              ? {}
              : { startedAt: at }),
          }
        : {}),
      ...(source === undefined ? {} : { sources: [source] }),
    })
  }
  const addTool = (
    turn: Turn | undefined,
    update: Record<string, unknown>,
    id: string,
    at: string,
    permission = false,
  ) => {
    const prior = tools.get(id)
    const owner = prior?.turn ?? turn
    if (owner === undefined) return
    if (turn !== undefined) closeText(turn, at)
    const fields = Object.fromEntries(
      Object.entries(update).filter(([, value]) => value != null),
    )
    const wire = { ...prior?.wire, ...fields }
    const index = prior?.index ?? owner.entries.length
    const entry = projectAcpTool(
      wire,
      id,
      owner.id,
      permission || prior?.entry.execution.requiresPermission === true,
    )
    owner.entries[index] = entry
    tools.set(id, { wire, turn: owner, index, entry })
  }
  const resolvePermission = (id: string, behavior?: string) => {
    permissions.delete(id)
    const location = permissionEntries.get(id)
    if (location === undefined) return
    const entry = location.turn.entries[location.index]
    if (entry?.kind === "permission")
      location.turn.entries[location.index] = {
        ...entry,
        state: "resolved",
        ...(behavior === undefined ? {} : { behavior }),
      }
  }
  let previousRawText:
    | { turnId: string; kind: TextEntry["kind"]; text: string }
    | undefined
  for (const { event, seq, createdAt } of events) {
    const at = new Date(createdAt).toISOString()
    const formerText = previousRawText
    previousRawText = undefined
    if (event.type === "permission.resolved") {
      resolvePermission(event.requestId, event.optionId)
      continue
    }
    const wireTurnId = event.turnId
    if (event.type === "session.update") {
      const { update } = event
      const channel = update.sessionUpdate
      const userMessageId =
        channel === "user_message_chunk"
          ? acpString(update.messageId)
          : undefined
      if (replay && typeof channel === "string") {
        if (
          replayTurnId === undefined ||
          (channel === "user_message_chunk" &&
            (userMessageId === undefined
              ? replayChannel !== channel
              : turns.get(replayTurnId)?.inputMessageId !== userMessageId))
        )
          replayTurnId = `acp:replay:${seq}`
        if (
          channel === "user_message_chunk" ||
          channel === "agent_message_chunk"
        )
          replayChannel = channel
      }
      const id = replay ? replayTurnId : (wireTurnId ?? activeTurnId)
      const turn = id === undefined ? undefined : turnFor(id, at)
      if (channel === "tool_call" || channel === "tool_call_update") {
        const toolCallId = acpString(update.toolCallId)
        if (toolCallId !== undefined) addTool(turn, update, toolCallId, at)
      } else if (
        turn !== undefined &&
        channel === "plan" &&
        Array.isArray(update.entries)
      ) {
        closeText(turn, at)
        const plan = update.entries.flatMap<SessionPlan["plan"][number]>(
          (value) => {
            const { content, status } = acpRecord(value)
            if (
              typeof content !== "string" ||
              (status !== "pending" &&
                status !== "in_progress" &&
                status !== "completed")
            )
              return []
            return [{ step: content, status }]
          },
        )
        turn.entries.push({
          kind: "plan",
          turnId: turn.id,
          itemId: `acp:plan:${seq}`,
          plan: { kind: "plan", plan },
        })
      } else if (
        turn !== undefined &&
        (channel === "agent_message_chunk" ||
          channel === "agent_thought_chunk" ||
          channel === "user_message_chunk")
      ) {
        const content = acpRecord(update.content)
        const { text, type } = content
        if (channel === "user_message_chunk") {
          if (userMessageId !== undefined) turn.inputMessageId = userMessageId
          if (!replay) continue
          const id = `acp:input-part:${seq}`
          const parts: ReplayedInputPart[] = []
          const textPart =
            type === "text" && typeof text === "string" ? text : undefined
          if (textPart !== undefined)
            parts.push({ type: "text", id, text: textPart })
          else {
            const display = acpMessageContent(content, id)
            if (display.image !== undefined)
              parts.push({
                type: "image",
                id: `${id}:image`,
                image: display.image,
              })
            if (display.source !== undefined) {
              const text = acpRecord(content.resource).text
              parts.push({
                type: "resource",
                id,
                source: display.source,
                ...(typeof text === "string" ? { text } : {}),
              })
            }
          }
          if (parts.length === 0) continue
          const full = (turn.input?.text ?? "") + (textPart ?? "")
          const earlier = turn.input?.replayedParts ?? []
          const previous = earlier.at(-1)
          const first = parts[0]
          const replayedParts =
            previous?.type === "text" && first?.type === "text"
              ? [
                  ...earlier.slice(0, -1),
                  { ...previous, text: previous.text + first.text },
                ]
              : [...earlier, ...parts]
          turn.input = {
            kind: "user_input",
            inputId: turn.id,
            text: full,
            content: createUserInput(full),
            replayedParts,
            at: turn.input?.at ?? at,
          }
          continue
        }
        if (type !== "text" || typeof text !== "string") {
          if (channel !== "agent_message_chunk") continue
          const display = acpMessageContent(content, `acp:source:${seq}`)
          addText(
            turn,
            "assistant",
            display.text ?? "",
            seq,
            at,
            display.source,
          )
          if (display.image !== undefined) {
            closeText(turn, at)
            turn.entries.push({
              kind: "image_output",
              itemId: `acp:image:${seq}`,
              turnId: turn.id,
              image: display.image,
              label: "Engine image",
            })
          }
          continue
        }
        const kind =
          channel === "agent_message_chunk" ? "assistant" : "reasoning"
        addText(turn, kind, text, seq, at)
        previousRawText = { turnId: turn.id, kind, text }
      }
      continue
    }
    const turn = turnFor(event.turnId, at)
    if (event.type === "message.delta") {
      if (
        formerText?.kind === event.channel &&
        formerText.text === event.text &&
        formerText.turnId === turn.id
      )
        continue
      addText(turn, event.channel, event.text, seq, at)
    } else if (event.type === "input.submitted") {
      turn.input = {
        kind: "user_input",
        inputId: event.requestId,
        requestId: event.requestId,
        text: event.text,
        content: event.content ?? createUserInput(event.text),
        ...(event.content?.references === undefined
          ? {}
          : { contextAttachments: event.content.references }),
        at,
      }
    } else if (event.type === "permission.requested") {
      if (permissions.has(event.requestId)) continue
      closeText(turn, at)
      const id = acpString(event.toolCall?.toolCallId) ?? event.requestId
      if (event.toolCall !== undefined)
        addTool(turn, event.toolCall, id, at, true)
      permissions.set(event.requestId, event)
      permissionEntries.set(event.requestId, {
        turn,
        index: turn.entries.length,
      })
      turn.entries.push({
        kind: "permission",
        turnId: turn.id,
        permissionRequestId: event.requestId,
        toolCallId: `acp:${id}`,
        action: event.description,
        state: "requested",
      })
    } else if (event.type === "turn.status") {
      if (event.status === "accepted" || event.status === "running") {
        activeTurnId = turn.id
        continue
      }
      closeText(turn, at)
      turn.completedAt = at
      if (activeTurnId === turn.id) activeTurnId = undefined
      for (const [id, permission] of permissions)
        if (permission.turnId === turn.id) resolvePermission(id)
      if (event.status !== "completed")
        turn.entries.push({
          kind: "turn_terminal",
          turnId: turn.id,
          state: event.status === "disconnected" ? "interrupted" : event.status,
          message:
            event.message ??
            (event.status === "disconnected"
              ? "The engine disconnected."
              : event.status === "failed"
                ? "The engine reported an error."
                : "The engine cancelled the response."),
        })
    }
  }
  for (const turn of turns.values())
    if (replay) turn.completedAt = turn.startedAt
  return { turns, tools, permissions, activeTurnId }
}

import {
  type AcpConfigControl,
  applyAcpConfig,
} from "../protocol/acp-config.ts"
