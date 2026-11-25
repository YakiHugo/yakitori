// @vitest-environment happy-dom
import { once } from "node:events"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { SubagentPanel } from "../../src/gui/components/subagent-panel.tsx"
import {
  createEventEnvelope,
  type KernelEvent,
} from "../../src/kernel/events.ts"
import type { ApiSessionDetail } from "../../src/server/protocol.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { inputParts } from "./input-fixtures.ts"

const at = "2026-09-20T00:00:00.000Z"
const snapshot: ApiSessionDetail = {
  id: "child",
  rolloutId: "rollout_child",
  conversationId: "child",
  title: "Review child",
  seq: 4,
  createdAt: at,
  updatedAt: at,
  pendingInputs: [],
  pendingPermissions: [],
  counts: {
    inputs: 1,
    pendingInputs: 0,
    turns: 1,
    items: 1,
    permissions: 0,
    tools: 0,
  },
}
const history: KernelEvent[] = [
  {
    type: "input.admitted",
    data: {
      requestId: "request",
      inputId: "input",
      role: "user",
      content: inputFixture(inputParts("Review the child history")),
    },
  },
  { type: "turn.started", data: { turnId: "turn", inputId: "input" } },
  {
    type: "item.completed",
    data: {
      turnId: "turn",
      item: {
        type: "agent_message",
        itemId: "answer",
        content: [{ type: "text", text: "The full history was recovered." }],
      },
    },
  },
  {
    type: "turn.completed",
    data: { turnId: "turn", outcome: { status: "completed" } },
  },
]
const envelopes = history.map((event, index) =>
  createEventEnvelope({
    sessionId: "child",
    seq: index + 1,
    createdAt: at,
    event,
  }),
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("retries a failed history page with a new live snapshot and renders each Turn once", async () => {
  vi.stubGlobal("WebSocket", WebSocket)
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  const address = server.address()
  if (typeof address === "string" || address === null)
    throw new Error("Missing fixture server address")
  const reads: unknown[] = []
  let attempt = 0
  server.on("connection", (socket) => {
    const title = `Review child attempt ${++attempt}`
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as {
        id: number
        method: string
        params: unknown
      }
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ id: message.id, result }))
      if (message.method === "session/open") {
        reads.push(message.params)
        if (attempt === 1) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32603, message: "History page unavailable" },
            }),
          )
          return
        }
        reply({
          session: { ...snapshot, title },
          watermarkSeq: snapshot.seq,
          history: {
            view: "summary",
            rolloutId: snapshot.rolloutId,
            seq: snapshot.seq,
            turns: [
              {
                turnId: "turn",
                completionSeq: 4,
                completedAt: at,
                outcome: "completed",
                activityCount: 0,
                events: envelopes,
              },
            ],
          },
        })
        return
      }
      reply({})
    })
  })
  try {
    render(
      <SubagentPanel
        sessionId="child"
        apiBase={`http://127.0.0.1:${address.port}`}
        active
        onBack={() => {}}
        onOpenAgent={() => {}}
      />,
    )
    expect((await screen.findByRole("alert")).textContent).toContain(
      "History page unavailable",
    )
    expect(screen.queryByText("Review child attempt 1")).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Review child attempt 2")).toBeDefined()
    expect(
      await screen.findAllByText("The full history was recovered."),
    ).toHaveLength(1)
    expect(await screen.findByText("Completed")).toBeDefined()
    expect(reads).toEqual([{ sessionId: "child" }, { sessionId: "child" }])
  } finally {
    cleanup()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      }),
    )
  }
})
