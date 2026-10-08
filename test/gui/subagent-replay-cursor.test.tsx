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

it.each([
  0, 1, 2,
])("retries interrupted replay after its %i delivered events, not the snapshot watermark", async (delivered) => {
  vi.stubGlobal("WebSocket", WebSocket)
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  const address = server.address()
  if (typeof address === "string" || address === null)
    throw new Error("Missing fixture server address")
  const cursors: number[] = []
  const replayPages: (() => void)[] = []
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as {
        id: number
        method: string
        params: { after: number }
      }
      if (message.method !== "session/subscribe") {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        return
      }
      cursors.push(message.params.after)
      socket.send(
        JSON.stringify({
          id: message.id,
          result: {
            session: {
              ...snapshot,
              title: `Review child attempt ${cursors.length}`,
            },
          },
        }),
      )
      const first = cursors.length === 1
      replayPages.push(() => {
        const events = first
          ? envelopes.slice(0, delivered)
          : envelopes.filter((event) => event.seq > message.params.after)
        for (const event of events)
          socket.send(
            JSON.stringify({
              method: "session/event",
              params: { sessionId: "child", seq: event.seq, event },
            }),
          )
        // The real subscription sends its snapshot before awaiting the first
        // history page; a failed page reports this terminal notification.
        socket.send(
          JSON.stringify({
            method: first
              ? "session/subscriptionError"
              : "session/replayComplete",
            params: first
              ? { sessionId: "child", message: "Session event replay failed." }
              : { sessionId: "child", seq: snapshot.seq },
          }),
        )
      })
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
    await screen.findByText("Review child attempt 1")
    replayPages[0]?.()
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
    await screen.findByText("Review child attempt 2")
    replayPages[1]?.()
    expect(
      await screen.findByText("The full history was recovered."),
    ).toBeDefined()
    expect(await screen.findByText("Completed")).toBeDefined()
    expect(cursors).toEqual([0, delivered])
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
