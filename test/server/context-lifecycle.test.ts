import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ContextExcerpt } from "../../src/kernel/input-context.ts"
import {
  ModelStopReason,
  type ModelRequest,
  type StreamFn,
} from "../../src/runtime/model.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import { handleServerControlRequest } from "../../src/server/server-process.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  vi.unstubAllEnvs()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Session.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(stream: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-context-contract-"))
  const options = {
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "openai",
    model: "gpt-test",
    stream,
  }
  let application = await createYakitoriApplication(options)
  cleanups.push(async () => {
    await application.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    get app() {
      return application
    },
    async restart() {
      await application.close()
      application = await createYakitoriApplication(options)
    },
  }
}

async function createMain(app: YakitoriApplication) {
  const created = await app.handlers.createSession({})
  if (!created.ok) throw new Error(created.body.error.message)
  return created.body.session.id
}

async function admit(
  app: YakitoriApplication,
  sessionId: string,
  requestId: string,
  text: string,
  contextAttachments?: readonly ContextExcerpt[],
) {
  const result = await app.handlers.admitInput({
    sessionId,
    requestId,
    content: {
      kind: "text",
      text,
      ...(contextAttachments === undefined ? {} : { contextAttachments }),
    },
  })
  if (!result.ok) throw new Error(result.body.error.message)
  await until(() => app.threadManager.getThread(sessionId)?.status === "idle")
  return result.body.inputId
}

const excerpts: readonly ContextExcerpt[] = [
  {
    id: "selection_1",
    kind: "selection",
    text: "frozen quoted passage",
    source: {
      kind: "message",
      label: "Earlier answer",
      sessionId: "source_session",
      messageId: "answer_1",
    },
  },
  {
    id: "annotation_1",
    kind: "annotation",
    text: "other passage",
    comment: "explain this",
    source: { kind: "file", label: "index.ts", path: "/project/index.ts" },
    anchor: { startOffset: 3, endOffset: 16 },
  },
]

describe("structured context and ephemeral forks", () => {
  it("keeps user text clean across model hydration, restart, replay, and edit forks", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "answer" }],
        },
      }
    })
    const id = await createMain(context.app)
    const inputId = await admit(
      context.app,
      id,
      "context_turn",
      "Explain this",
      excerpts,
    )
    const requestUser = requests[0]?.messages
      .filter(
        (message) => message.role === "user" && message.context === undefined,
      )
      .at(-1)
    expect(requestUser).toMatchObject({
      content: [
        { type: "text", text: "Explain this" },
        {
          type: "text",
          text: expect.stringContaining("frozen quoted passage"),
        },
      ],
    })
    expect(requestUser).not.toHaveProperty("contextAttachments")
    const stored = await context.app.threadStore.readThread(id)
    expect(
      stored?.rollout.find(
        ({ item }) => item.type === "response_item" && item.item.id === inputId,
      )?.item,
    ).toMatchObject({
      item: {
        item: {
          content: [{ type: "text", text: "Explain this" }],
          contextAttachments: excerpts,
        },
      },
    })
    await context.restart()
    const events = await context.app.handlers.readSessionEvents({
      sessionId: id,
    })
    if (!events.ok) throw new Error(events.body.error.message)
    expect(JSON.stringify(events.body)).toContain('"contextAttachments"')
    expect(JSON.stringify(events.body)).toContain('"text":"Explain this"')
    await admit(context.app, id, "context_turn", "Explain this", excerpts)
    expect(requests).toHaveLength(1)
    await admit(context.app, id, "only_context", "", excerpts)
    expect(
      requests
        .at(-1)
        ?.messages.filter(
          (message) => message.role === "user" && message.context === undefined,
        )
        .at(-1),
    ).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("frozen quoted passage"),
        },
      ],
    })
    const forked = await context.app.handlers.forkSession({
      sessionId: id,
      atInputId: inputId,
      reason: "edit",
      content: { kind: "text", text: "Fresh question" },
    })
    if (!forked.ok) throw new Error(forked.body.error.message)
    await until(
      () =>
        context.app.threadManager.getThread(forked.body.session.id)?.status ===
        "idle",
    )
    const child = await context.app.threadStore.readThread(
      forked.body.session.id,
    )
    expect(
      child?.rollout.find(
        ({ item }) =>
          item.type === "response_item" && item.item.id.startsWith("input_"),
      )?.item,
    ).toMatchObject({
      item: {
        item: {
          content: [{ type: "text", text: "Fresh question" }],
          contextAttachments: excerpts,
        },
      },
    })
  })

  it("freezes completed parent history at creation and targets the new side user request", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      const latestUser = request.messages
        .filter(
          (message) => message.role === "user" && message.context === undefined,
        )
        .at(-1)
      if (
        latestUser?.role === "user" &&
        latestUser.content[0]?.text === "unfinished parent task"
      ) {
        yield { type: "snapshot", text: "unfinished parent answer" }
        if (!request.signal) throw new Error("Missing abort signal")
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        )
        yield { type: "cancelled" }
        return
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "completed parent answer" }],
        },
      }
    })
    const id = await createMain(context.app)
    await admit(context.app, id, "parent_first", "Old task: change everything")
    const active = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "parent_active",
      content: { kind: "text", text: "unfinished parent task" },
    })
    if (!active.ok) throw new Error(active.body.error.message)
    await until(() => requests.length === 2)
    const side = await context.app.sideChats.create({ sourceSessionId: id })
    expect(side).toMatchObject({
      cwd: context.app.workspace,
      modelSelection: { provider: "openai", model: "gpt-test" },
      messages: [],
    })
    const cancelled = await context.app.handlers.cancelTurn({
      sessionId: id,
      turnId: "parent_active",
    })
    if (!cancelled.ok) throw new Error(cancelled.body.error.message)
    await until(
      () => context.app.threadManager.getThread(id)?.status === "idle",
    )
    await admit(
      context.app,
      id,
      "parent_later",
      "Do not inherit this later request",
    )
    await context.app.sideChats.send({
      sideChatId: side.id,
      requestId: "side_first",
      text: "Explain the decision only",
      contextAttachments: excerpts,
    })
    await until(
      () => context.app.sideChats.read(side.id).activeTurnId === undefined,
    )
    const request = requests.at(-1)
    expect(JSON.stringify(request?.messages)).toContain(
      "Old task: change everything",
    )
    expect(JSON.stringify(request?.messages)).toContain(
      "completed parent answer",
    )
    expect(JSON.stringify(request?.messages)).not.toContain(
      "Do not inherit this later request",
    )
    expect(JSON.stringify(request?.messages)).not.toContain("unfinished parent")
    expect(JSON.stringify(request?.messages)).toContain(
      "not an active task or instructions",
    )
    expect(
      request?.messages
        .filter(
          (message) => message.role === "user" && message.context === undefined,
        )
        .at(-1),
    ).toMatchObject({
      content: [
        { type: "text", text: "Explain the decision only" },
        {
          type: "text",
          text: expect.stringContaining("frozen quoted passage"),
        },
      ],
    })
    expect(context.app.sideChats.read(side.id).messages[0]).toMatchObject({
      text: "Explain the decision only",
      contextAttachments: excerpts,
    })
    const nested = await context.app.sideChats.create({
      sourceSessionId: side.id,
    })
    await context.app.sideChats.send({
      sideChatId: nested.id,
      requestId: "nested_first",
      text: "Explain the side answer",
    })
    await until(
      () => context.app.sideChats.read(nested.id).activeTurnId === undefined,
    )
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "Explain the decision only",
    )
    expect(await context.app.threadStore.listThreadIds()).toEqual([id])
  })

  it("keeps inherited images model-visible after deleting the parent and closing an intermediate side chat", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "image answer" }],
        },
      }
    })
    const parentId = await createMain(context.app)
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer()
    const attachments = await context.app.rolloutAssets.importImageBytes(
      parentId,
      "parent_image_draft",
      [{ name: "parent.png", data: bytes }],
    )
    const admitted = await context.app.handlers.admitInput({
      sessionId: parentId,
      requestId: "parent_image_turn",
      modelSelection: { provider: "openai", model: "gpt-5" },
      content: { kind: "text", text: "Describe the parent image", attachments },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await until(
      () => context.app.threadManager.getThread(parentId)?.status === "idle",
    )
    const stored = await context.app.threadStore.readThread(parentId)
    const parentImage = stored?.rollout.flatMap(({ item }) =>
      item.type === "response_item" && item.item.item.role === "user"
        ? (item.item.item.images ?? [])
        : [],
    )[0]
    if (!parentImage?.file) throw new Error("Missing stored parent image")
    const side = await context.app.sideChats.create({
      sourceSessionId: parentId,
    })
    expect(side.messages).toEqual([])
    const deleted = await context.app.handlers.deleteSession({
      sessionId: parentId,
    })
    if (!deleted.ok) throw new Error(deleted.body.error.message)
    await expect(
      context.app.rolloutAssets.read(parentImage.file),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await context.app.sideChats.send({
      sideChatId: side.id,
      requestId: "side_image_question",
      text: "Explain the image color only",
    })
    await until(
      () => context.app.sideChats.read(side.id).activeTurnId === undefined,
    )
    const nested = await context.app.sideChats.create({
      sourceSessionId: side.id,
    })
    await context.app.sideChats.remove(side.id)
    await context.app.sideChats.send({
      sideChatId: nested.id,
      requestId: "nested_image_question",
      text: "Explain the same image again",
    })
    await until(
      () => context.app.sideChats.read(nested.id).activeTurnId === undefined,
    )
    for (const request of requests.slice(1)) {
      const images = request.messages.flatMap((message) =>
        message.role === "user" ? (message.images ?? []) : [],
      )
      expect(images).toHaveLength(1)
      const image = images[0]
      if (!image?.data)
        throw new Error("Inherited image was not materialized for the model")
      const pixels = await sharp(Buffer.from(image.data, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer()
      expect([...pixels.subarray(0, 3)]).toEqual([17, 34, 51])
      expect(
        JSON.stringify(
          request.messages.filter((message) => message.role === "developer"),
        ),
      ).not.toContain(bytes.toString("base64"))
    }
    expect(
      requests
        .at(-1)
        ?.messages.filter(
          (message) => message.role === "user" && message.context === undefined,
        )
        .at(-1),
    ).toMatchObject({
      content: [{ type: "text", text: "Explain the same image again" }],
    })
    expect(await context.app.threadStore.listThreadIds()).toEqual([])
    await context.app.sideChats.remove(nested.id)
    expect(() => context.app.sideChats.read(nested.id)).toThrow(
      "no longer available",
    )
  })

  it("uses workspace tools and project instructions, materializes side images, and removes assets on close", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      if (!request.messages.some((message) => message.role === "tool")) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "read_side_file",
                name: "read_file",
                input: { path: "note.txt" },
              },
            ],
          },
        }
      } else {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.EndTurn,
            content: [{ type: "text", text: "inspected" }],
          },
        }
      }
    })
    await writeFile(
      join(context.root, "AGENTS.md"),
      "Project instruction: use the local fixture.",
    )
    await writeFile(join(context.root, "note.txt"), "real workspace evidence")
    const imagePath = join(context.root, "image.png")
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#ffffff" },
    })
      .png()
      .toFile(imagePath)
    const side = await context.app.sideChats.create({
      modelSelection: { provider: "openai", model: "gpt-5" },
    })
    const imported = await handleServerControlRequest(context.app, {
      type: "import_image_paths",
      requestId: "import_side",
      sessionId: side.id,
      ownerId: "draft_side",
      paths: [imagePath],
    })
    if (!imported.ok || !("attachments" in imported))
      throw new Error(JSON.stringify(imported))
    await context.app.sideChats.send({
      sideChatId: side.id,
      requestId: "side_image",
      text: "Inspect the file and image",
      attachments: imported.attachments,
    })
    await until(
      () => context.app.sideChats.read(side.id).activeTurnId === undefined,
    )
    expect(JSON.stringify(requests)).toContain("real workspace evidence")
    expect(JSON.stringify(requests)).toContain(
      "Project instruction: use the local fixture",
    )
    expect(JSON.stringify(requests[0]?.messages)).toContain('"data":')
    expect(
      requests[0]?.tools.some((tool) => tool.name.endsWith("read_file")),
    ).toBe(true)
    expect(
      requests[0]?.tools.some((tool) =>
        /spawn_agent|send_message|wait_agent/.test(tool.name),
      ),
    ).toBe(false)
    const attachment = context.app.sideChats.read(side.id).messages[0]
      ?.attachments?.[0]
    if (!attachment) throw new Error("Missing promoted attachment")
    expect(await context.app.rolloutAssets.read(attachment.file)).toEqual(
      await readFile(imagePath),
    )
    expect(await context.app.threadStore.listThreadIds()).toEqual([])
    const ordinary = await createMain(context.app)
    const removed = await context.app.handlers.deleteSession({
      sessionId: ordinary,
    })
    if (!removed.ok) throw new Error(removed.body.error.message)
    expect(await context.app.rolloutAssets.read(attachment.file)).toEqual(
      await readFile(imagePath),
    )
    await context.app.sideChats.remove(side.id)
    await expect(
      context.app.rolloutAssets.read(attachment.file),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("exposes ordinary tool permission requests and cancels pending permission waits on removal", async () => {
    vi.stubEnv("YAKITORI_APPROVAL_POLICY", "auto_file_tools")
    const context = await fixture(async function* () {
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.ToolUse,
          content: [
            {
              type: "tool_call",
              id: "side_exec",
              name: "exec_command",
              input: { cmd: "echo side-effect > blocked.txt" },
            },
          ],
        },
      }
    })
    const side = await context.app.sideChats.create({})
    await context.app.sideChats.send({
      sideChatId: side.id,
      requestId: "permission_turn",
      text: "Run the command",
    })
    await until(
      () =>
        (context.app.sideChats.read(side.id).pendingPermissions?.length ?? 0) >
        0,
    )
    expect(
      context.app.sideChats.read(side.id).pendingPermissions?.[0],
    ).toMatchObject({ sessionId: side.id, turnId: "permission_turn" })
    await context.app.sideChats.remove(side.id)
    await expect(
      readFile(join(context.root, "blocked.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
})
