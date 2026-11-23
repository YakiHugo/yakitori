import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { pngImageBase64 } from "../images.ts"

const mode = process.argv[2] ?? "resume"
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const reply = (id, result) => send({ id, result })
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } })
const text = (sessionId, value) =>
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
  })
const outputMedia = (sessionId) => {
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "draw_fixture",
    title: "Draw fixture",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "image", data: pngImageBase64, mimeType: "image/png" },
      },
    ],
  })
  for (const content of [
    { type: "text", text: "The ACP resource is ready." },
    {
      type: "resource_link",
      name: "Engine reference",
      uri: "https://example.test/engine/reference",
    },
    {
      type: "resource",
      resource: {
        uri: "file:///fixture/engine-notes.txt",
        mimeType: "text/plain",
        text: "Embedded engine notes",
      },
    },
    { type: "image", data: pngImageBase64, mimeType: "image/png" },
  ])
    update(sessionId, { sessionUpdate: "agent_message_chunk", content })
}
let prompt
let pendingPermission
let effort = "fast"
const configOptions = () => [
  {
    type: "select",
    id: "thought_level",
    name: "Reasoning level",
    category: "thought_level",
    currentValue: effort,
    options: [
      {
        group: "reasoning-modes",
        name: "Reasoning modes",
        options: [
          { value: "fast", name: "Fast" },
          { value: "deep", name: "Deep" },
        ],
      },
    ],
  },
]
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line)
  if (m.method === "initialize") {
    if (
      m.params.protocolVersion !== 1 ||
      m.params.clientCapabilities.terminal !== false ||
      m.params.clientCapabilities.fs.readTextFile !== false
    )
      process.exit(12)
    reply(m.id, {
      protocolVersion: mode === "v2" ? 2 : 1,
      agentCapabilities: {
        ...(["load", "load-media"].includes(mode) ? { loadSession: true } : {}),
        ...(mode === "config"
          ? { promptCapabilities: { image: true, embeddedContext: true } }
          : {}),
        sessionCapabilities: ["resume", "config"].includes(mode)
          ? { resume: {}, list: {} }
          : {},
      },
      authMethods: [],
      ...(mode === "steering"
        ? { _meta: { steering: { supported: true } } }
        : {}),
    })
  } else if (m.method === "session/new") {
    update("external-session", {
      sessionUpdate: "available_commands_update",
      availableCommands:
        mode === "config"
          ? [{ name: "status", description: "Show engine status" }]
          : [],
    })
    reply(m.id, {
      sessionId: "external-session",
      ...(mode === "config" ? { configOptions: configOptions() } : {}),
    })
  } else if (m.method === "session/set_config_option") {
    if (
      mode !== "config" ||
      m.params.configId !== "thought_level" ||
      m.params.value !== "deep"
    )
      process.exit(17)
    effort = m.params.value
    reply(m.id, { configOptions: configOptions() })
  } else if (m.method === "session/resume") {
    if (mode !== "resume" && mode !== "config") process.exit(13)
    reply(m.id, {})
  } else if (m.method === "session/load") {
    if (mode === "load") text(m.params.sessionId, "replayed history")
    else if (mode === "load-media") {
      const user = (messageId, content) =>
        update(m.params.sessionId, {
          sessionUpdate: "user_message_chunk",
          messageId,
          content,
        })
      user("older-user", { type: "text", text: "First historical message" })
      user("media-user", { type: "text", text: "Second historical message" })
      user("media-user", {
        type: "image",
        mimeType: "image/png",
        data: pngImageBase64,
      })
      user("media-user", {
        type: "resource",
        resource: {
          uri: "https://example.test/history.txt",
          mimeType: "text/plain",
          text: "Historical attachment contents",
        },
      })
      update(m.params.sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Reasoning from history." },
      })
      text(m.params.sessionId, "Replayed reply")
    } else process.exit(14)
    reply(m.id, {})
  } else if (m.method === "session/prompt") {
    prompt = m
    const content = m.params.prompt[0].text
    if (content === "Use the quote") {
      const resource = m.params.prompt.find(
        (part) => part.type === "resource",
      )?.resource
      if (
        mode !== "config" ||
        resource?.mimeType !== "text/plain" ||
        resource.text !== "Engine received the image."
      )
        process.exit(19)
      text(m.params.sessionId, "Engine received the quote.")
      reply(m.id, { stopReason: "end_turn" })
      return
    }
    if (content?.trim() === "Check the image") {
      const image = m.params.prompt.find((part) => part.type === "image")
      if (
        mode !== "config" ||
        image?.mimeType !== "image/png" ||
        typeof image.data !== "string" ||
        !image.data.startsWith("iVBORw0KGgo")
      )
        process.exit(18)
      text(m.params.sessionId, "Engine received the image.")
      reply(m.id, { stopReason: "end_turn" })
      return
    }
    if (content === "die") return process.exit(3)
    if (content.startsWith("descendant:")) {
      const [, pipes, heartbeat] = content.split(":")
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(process.argv[1], '.'), 20); process.send('ready')`,
          heartbeat,
        ],
        {
          stdio: [
            "ignore",
            pipes === "inherit" ? "inherit" : "ignore",
            pipes === "inherit" ? "inherit" : "ignore",
            "ipc",
          ],
        },
      )
      child.once("message", () => process.exit(0))
      return
    }
    if (content === "malformed") return process.stdout.write("invalid json\n")
    if (content === "partial") {
      const frame = Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: m.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial: 焼き鳥" },
            },
          },
        })}\n`,
      )
      const split = frame.indexOf(Buffer.from("焼")) + 1
      process.stdout.write(frame.subarray(0, split))
      setTimeout(() => {
        process.stdout.write(frame.subarray(split))
        reply(m.id, { stopReason: "end_turn" })
      }, 10)
      return
    }
    text(m.params.sessionId, "first")
    if (content === "permission" || content === "cancel-permission") {
      pendingPermission = m
      send({
        id: "permission:opaque",
        method: "session/request_permission",
        params: {
          sessionId: m.params.sessionId,
          toolCall: {
            toolCallId: "tool1",
            title: "Run fixture command",
            rawInput: { command: "echo fixture" },
          },
          options: [
            {
              optionId: "opaque:allow/once",
              name: "Allow this",
              kind: "allow_once",
            },
            { optionId: "opaque:deny", name: "Reject", kind: "reject_once" },
          ],
        },
      })
    } else if (content === "structured") {
      update(m.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "edit_fixture",
        title: "Edit the fixture",
        kind: "edit",
        status: "completed",
        locations: [
          { path: "/fixture/fixture.txt", line: 2 },
          { path: "/fixture/related.txt", line: 7 },
          { path: "/fixture/fixture.txt", line: 2 },
        ],
        content: [
          {
            type: "diff",
            path: "fixture.txt",
            oldText: "before\n",
            newText: "after\n",
          },
        ],
      })
      update(m.params.sessionId, {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Check the fixture",
            status: "completed",
            priority: "high",
          },
        ],
      })
      text(m.params.sessionId, "The ACP fixture is ready.")
      reply(m.id, { stopReason: "end_turn" })
    } else if (content === "output-media") {
      update(m.params.sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Plan the ACP fixture image." },
      })
      outputMedia(m.params.sessionId)
      setTimeout(() => reply(m.id, { stopReason: "end_turn" }), 1500)
    } else if (content === "invalid-stop") reply(m.id, {})
    else if (content === "cancel") {
      /* only finish after cancel notification */
    } else if (content === "callbacks")
      send({
        id: "unsupported",
        method: "fs/read_text_file",
        params: { sessionId: m.params.sessionId, path: "/tmp/file" },
      })
    else {
      update(m.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Example",
        status: "completed",
      })
      reply(m.id, { stopReason: "end_turn" })
    }
  } else if (m.id === "permission:opaque") {
    if (pendingPermission.params.prompt[0].text === "cancel-permission") {
      if (m.result.outcome.outcome !== "cancelled") process.exit(15)
    } else {
      text(prompt.params.sessionId, m.result.outcome.optionId)
      reply(prompt.id, { stopReason: "end_turn" })
    }
  } else if (m.id === "unsupported") {
    if (m.error?.code !== -32601) process.exit(16)
    reply(prompt.id, { stopReason: "end_turn" })
  } else if (m.method === "session/cancel") {
    if ("id" in m) process.exit(17)
    setTimeout(() => {
      text(m.params.sessionId, "cancellation tail")
      reply(prompt.id, { stopReason: "cancelled" })
    }, 40)
  }
})
