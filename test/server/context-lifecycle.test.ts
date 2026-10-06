import { isKernelEvent, type InputContent } from "../../src/kernel/events.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StoredRolloutItem } from "../../src/core/rollout.ts"
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
import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"
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
    async restart(beforeReopen?: () => Promise<void>) {
      await application.close()
      await beforeReopen?.()
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
      kind: "parts" as const,
      parts: text === "" ? [] : [{ type: "text" as const, text }],
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
  it.each([
    "steer",
    "queue",
  ] as const)("preserves ordered %s admission, request retries and durable replay", async (route) => {
    const requests: ModelRequest[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let finishSecond!: () => void
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve
    })
    const context = await fixture(async function* (request) {
      requests.push(request)
      if (requests.length === 1) await gate
      if (requests.length === 2 && route === "steer") await secondGate
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    })
    cleanups.push(async () => {
      release()
      finishSecond()
    })
    const id = await createMain(context.app)
    const initial = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "ordered_active",
      modelSelection: { provider: "openai", model: "gpt-5" },
      content: { kind: "parts", parts: [{ type: "text", text: "start" }] },
    })
    if (!initial.ok) throw new Error(initial.body.error.message)
    await until(() => requests.length === 1)
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#112233" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    const changedBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#445566" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(changedBytes.length).toBe(bytes.length)
    const [image] = await context.app.rolloutAssets.importAttachmentBytes(
      id,
      "ordered_draft",
      [{ name: "placed.png", data: bytes }],
    )
    if (!image || image.mediaType === "application/pdf")
      throw new Error("Missing draft")
    const content: InputContent = {
      kind: "parts",
      parts: [
        { type: "text", text: "before image" },
        { type: "image", ...image },
        { type: "text", text: "after image" },
      ],
    }
    const submit = (content: InputContent) =>
      route === "steer"
        ? context.app.handlers.steerInput({
            sessionId: id,
            requestId: "ordered_followup",
            expectedTurnId: "ordered_active",
            content,
          })
        : context.app.handlers.queueInput({
            sessionId: id,
            requestId: "ordered_followup",
            content,
          })
    const accepted = await submit(content)
    if (!accepted.ok) throw new Error(accepted.body.error.message)
    expect(await submit(content)).toMatchObject({
      ok: true,
      body: accepted.body,
    })
    expect(
      await submit({
        kind: "parts",
        parts: [
          { type: "image", ...image },
          { type: "text", text: "before imageafter image" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 409 })
    const [changed] = await context.app.rolloutAssets.importAttachmentBytes(
      id,
      "changed_draft",
      [{ name: "placed.png", data: changedBytes }],
    )
    if (!changed || changed.mediaType === "application/pdf")
      throw new Error("Missing changed draft")
    expect(
      await submit({
        kind: "parts",
        parts: [
          { type: "text", text: "before image" },
          { type: "image", ...changed },
          { type: "text", text: "after image" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 409 })
    expect(await context.app.rolloutAssets.read(changed.file)).toEqual(
      changedBytes,
    )
    release()
    await until(() => requests.length === 2)
    if (route === "steer") {
      const [retryImage] =
        await context.app.rolloutAssets.importAttachmentBytes(
          id,
          "after_sample_retry",
          [{ name: "placed.png", data: bytes }],
        )
      if (!retryImage || retryImage.mediaType === "application/pdf")
        throw new Error("Missing retry image")
      expect(
        await submit({
          kind: "parts",
          parts: [
            { type: "text", text: "before image" },
            { type: "image", ...retryImage },
            { type: "text", text: "after image" },
          ],
        }),
      ).toMatchObject({ ok: true })
      await expect(
        context.app.rolloutAssets.read(retryImage.file),
      ).rejects.toMatchObject({ code: "ENOENT" })
    }
    finishSecond()
    await until(
      () =>
        requests.length === 2 &&
        context.app.threadManager.getThread(id)?.status === "idle",
    )
    expect(
      requests[1]?.messages.filter(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text === "before image",
          ),
      ),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "before image" },
          {
            type: "image",
            mediaType: "image/png",
            detail: "high",
            data: bytes.toString("base64"),
          },
          { type: "text", text: "after image" },
        ],
      },
    ])
    await expect
      .poll(() =>
        context.app.rolloutAssets.read(image.file).then(
          () => "exists",
          (error: NodeJS.ErrnoException) => error.code,
        ),
      )
      .toBe("ENOENT")
    await context.restart()
    const events = await context.app.handlers.readSessionEvents({
      sessionId: id,
    })
    if (!events.ok) throw new Error(events.body.error.message)
    const admissions = events.body.events.filter(
      (entry) =>
        entry.type === "input.admitted" &&
        entry.data.requestId === "ordered_followup",
    )
    expect(admissions).toHaveLength(1)
    expect(admissions[0]).toMatchObject({
      data: {
        content: {
          kind: "parts",
          parts: [
            { type: "text", text: "before image" },
            {
              type: "image",
              name: "placed.png",
              file: {
                rolloutId: id,
                path: "attachments/requests/ordered_followup/1.png",
              },
            },
            { type: "text", text: "after image" },
          ],
        },
      },
    })
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(
      "requestFingerprint",
    )
    const replayed = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "ordered_followup",
      content: accepted.body.content,
    })
    expect(replayed).toMatchObject({
      ok: true,
      status: 200,
      body: {
        turnId: route === "steer" ? "ordered_active" : "ordered_followup",
        content: accepted.body.content,
      },
    })
    expect(requests).toHaveLength(2)
    expect(
      await context.app.handlers.admitInput({
        sessionId: id,
        requestId: "ordered_followup",
        content: {
          ...accepted.body.content,
          parts: [...accepted.body.content.parts].reverse(),
        },
      }),
    ).toMatchObject({ ok: false, status: 409 })
    if (route === "steer") {
      expect(await submit(accepted.body.content)).toMatchObject({
        ok: true,
        body: { turnId: "ordered_active", content: accepted.body.content },
      })
      await context.restart(async () => {
        const path = join(
          context.app.sessionStoreRoot,
          "rollouts",
          id,
          "rollout.jsonl",
        )
        const lines = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map((line): StoredRolloutItem => JSON.parse(line))
        const legacy = lines.map((line) => {
          if (
            line.item.type !== "response_item" ||
            line.item.item.turnId !== "ordered_followup"
          )
            return line
          const { requestFingerprint: _fingerprint, ...metadata } =
            line.item.item.submissionMetadata ?? {}
          return {
            ...line,
            item: {
              ...line.item,
              item: { ...line.item.item, submissionMetadata: metadata },
            },
          }
        })
        await writeFile(
          path,
          `${legacy.map((line) => JSON.stringify(line)).join("\n")}\n`,
        )
      })
      expect(await submit(accepted.body.content)).toMatchObject({
        ok: false,
        status: 409,
        body: { error: { details: { reason: "request_conflict" } } },
      })
      expect(requests).toHaveLength(2)
    }
  })

  it.each([
    "direct",
    "queue",
    "steer",
  ] as const)("preserves mixed PDF/image %s input through admission and replay", async (route) => {
    const requests: ModelRequest[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const context = await fixture(async function* (request) {
      requests.push(request)
      if (route !== "direct" && requests.length === 1) await gate
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    })
    cleanups.push(async () => {
      release()
    })
    const id = await createMain(context.app)
    if (route !== "direct") {
      const initial = await context.app.handlers.admitInput({
        sessionId: id,
        requestId: "mixed_active",
        modelSelection: { provider: "openai", model: "gpt-6-astra" },
        content: { kind: "parts", parts: [{ type: "text", text: "wait" }] },
      })
      if (!initial.ok) throw new Error(initial.body.error.message)
      await until(() => requests.length === 1)
    }
    const pdfBytes = pdfFixture(["Authored PDF"])
    const imageBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer()
    const [pdf, image] = await context.app.rolloutAssets.importAttachmentBytes(
      id,
      "mixed_draft",
      [
        { name: "report.pdf", data: pdfBytes },
        { name: "image.png", data: imageBytes },
      ],
    )
    if (
      pdf?.mediaType !== "application/pdf" ||
      !image ||
      image.mediaType === "application/pdf"
    )
      throw new Error("Missing mixed fixture attachments")
    const content: InputContent = {
      kind: "parts",
      parts: [
        { type: "text", text: "before PDF" },
        { type: "document", ...pdf },
        { type: "text", text: "between media" },
        { type: "image", ...image },
        { type: "text", text: "after image" },
      ],
    }
    const submit = (value: InputContent) => {
      const request = {
        sessionId: id,
        requestId: "mixed_request",
        content: value,
        modelSelection: { provider: "openai", model: "gpt-6-astra" },
      }
      return route === "steer"
        ? context.app.handlers.steerInput({
            ...request,
            expectedTurnId: "mixed_active",
          })
        : route === "queue"
          ? context.app.handlers.queueInput(request)
          : context.app.handlers.admitInput(request)
    }
    const accepted = await submit(content)
    if (!accepted.ok) throw new Error(accepted.body.error.message)
    expect(await submit(content)).toMatchObject({
      ok: true,
      body: accepted.body,
    })
    expect(
      await submit({ ...content, parts: [...content.parts].reverse() }),
    ).toMatchObject({ ok: false, status: 409 })
    expect(
      await submit({
        ...content,
        parts: content.parts.map((part) =>
          part.type === "document"
            ? { ...part, sizeBytes: part.sizeBytes + 1 }
            : part,
        ),
      }),
    ).toMatchObject({ ok: false, status: 409 })
    release()
    await until(
      () =>
        requests.length === (route === "direct" ? 1 : 2) &&
        context.app.threadManager.getThread(id)?.status === "idle",
    )
    const user = requests
      .at(-1)
      ?.messages.filter(
        (message) => message.role === "user" && message.context === undefined,
      )
      .at(-1)
    expect(user?.content.map((block) => block.type)).toEqual([
      "text",
      "text",
      "image",
      "text",
      "image",
      "text",
    ])
    expect(user?.content[0]).toEqual({ type: "text", text: "before PDF" })
    expect(user?.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("report.pdf"),
    })
    expect(user?.content[3]).toEqual({ type: "text", text: "between media" })
    expect(user?.content[5]).toEqual({ type: "text", text: "after image" })
    await context.restart()
    const events = await context.app.handlers.readSessionEvents({
      sessionId: id,
    })
    if (!events.ok) throw new Error(events.body.error.message)
    const admission = events.body.events.find(
      (event) =>
        isKernelEvent(event) &&
        event.type === "input.admitted" &&
        event.data.requestId === "mixed_request",
    )
    if (!isKernelEvent(admission) || admission.type !== "input.admitted")
      throw new Error("Missing PDF admission")
    expect(admission.data.content.parts.map((part) => part.type)).toEqual([
      "text",
      "document",
      "text",
      "image",
      "text",
    ])
    const storedPdf = admission.data.content.parts.find(
      (part) => part.type === "document",
    )
    if (!storedPdf) throw new Error("Missing persisted PDF")
    expect(await context.app.rolloutAssets.read(storedPdf.file)).toEqual(
      pdfBytes,
    )
    expect(
      await context.app.handlers.admitInput({
        sessionId: id,
        requestId: "mixed_request",
        modelSelection: { provider: "openai", model: "gpt-6-astra" },
        content: admission.data.content,
      }),
    ).toMatchObject({ ok: true, status: 200 })
    if (route === "direct") {
      const foreign = await context.app.handlers.forkSession({
        sessionId: id,
        atInputId: admission.data.inputId,
        reason: "edit",
        content: {
          kind: "parts",
          parts: [
            {
              ...storedPdf,
              file: {
                ...storedPdf.file,
                path: "attachments/requests/foreign/1.pdf",
              },
            },
          ],
        },
      })
      expect(foreign).toMatchObject({ ok: false, status: 400 })
      const forked = await context.app.handlers.forkSession({
        sessionId: id,
        atInputId: admission.data.inputId,
        reason: "edit",
        content: {
          kind: "parts",
          parts: [storedPdf, { type: "text", text: "PDF first" }],
        },
      })
      if (!forked.ok) throw new Error(forked.body.error.message)
      await until(
        () =>
          context.app.threadManager.getThread(forked.body.session.id)
            ?.status === "idle",
      )
      expect(
        await context.app.handlers.deleteSession({ sessionId: id }),
      ).toMatchObject({ ok: true })
      const fork = await context.app.threadStore.readThread(
        forked.body.session.id,
      )
      const document = fork?.rollout.flatMap(({ item }) =>
        item.type === "response_item" && item.item.item.role === "user"
          ? item.item.item.content.filter((block) => block.type === "document")
          : [],
      )[0]
      if (!document) throw new Error("Missing fork PDF")
      expect(document.file.rolloutId).toBe(forked.body.session.id)
      expect(await context.app.rolloutAssets.read(document.file)).toEqual(
        pdfBytes,
      )
    }
  })

  it("retains edited image positions, rejects foreign assets, and copies source images across parent deletion", async () => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    })
    const id = await createMain(context.app)
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer()
    const attachments = await context.app.rolloutAssets.importAttachmentBytes(
      id,
      "fork_images",
      [
        { name: "first.png", data: bytes },
        { name: "second.png", data: bytes },
      ],
    )
    const [first, second] = attachments
    if (!first || !second) throw new Error("Missing fixture images")
    const initial = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "fork_source",
      modelSelection: { provider: "openai", model: "gpt-6-astra" },
      content: {
        kind: "parts",
        parts: [
          { type: "text", text: "before" },
          { type: "image", ...first },
          { type: "text", text: "between" },
          { type: "image", ...second },
          { type: "text", text: "after" },
        ],
      },
    })
    if (!initial.ok) throw new Error(initial.body.error.message)
    await until(
      () => context.app.threadManager.getThread(id)?.status === "idle",
    )
    const events = await context.app.handlers.readSessionEvents({
      sessionId: id,
    })
    if (!events.ok) throw new Error(events.body.error.message)
    const source = events.body.events.find(
      (entry) =>
        isKernelEvent(entry) &&
        entry.type === "input.admitted" &&
        entry.data.inputId === initial.body.inputId,
    )
    if (!isKernelEvent(source) || source.type !== "input.admitted")
      throw new Error("Missing source input")
    const [firstImage, secondImage] = source.data.content.parts.filter(
      (part) => part.type === "image",
    )
    if (!firstImage || !secondImage)
      throw new Error("Missing durable source images")
    const beforeInvalid = await context.app.threadStore.listThreadIds()
    const invalid = await context.app.handlers.forkSession({
      sessionId: id,
      atInputId: initial.body.inputId,
      reason: "edit",
      modelSelection: { provider: "openai", model: "gpt-6-astra" },
      content: {
        kind: "parts",
        parts: [
          {
            ...firstImage,
            file: {
              ...firstImage.file,
              path: "attachments/requests/other/1.png",
            },
          },
        ],
      },
    })
    expect(invalid).toMatchObject({
      ok: false,
      status: 400,
      body: {
        error: { message: expect.stringContaining("edited source input") },
      },
    })
    expect(await context.app.threadStore.listThreadIds()).toEqual(beforeInvalid)
    const edited = await context.app.handlers.forkSession({
      sessionId: id,
      atInputId: initial.body.inputId,
      reason: "edit",
      modelSelection: { provider: "openai", model: "gpt-6-astra" },
      content: {
        kind: "parts",
        parts: [
          { type: "text", text: "changed before" },
          { ...secondImage, detail: "original" },
          { type: "text", text: "changed middle" },
          firstImage,
          { type: "text", text: "changed after" },
        ],
      },
    })
    if (!edited.ok) throw new Error(edited.body.error.message)
    const childId = edited.body.session.id
    await until(
      () => context.app.threadManager.getThread(childId)?.status === "idle",
    )
    const user = requests
      .at(-1)
      ?.messages.filter(
        (message) => message.role === "user" && message.context === undefined,
      )
      .at(-1)
    expect(user).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "changed before" },
        { type: "image", detail: "original" },
        { type: "text", text: "changed middle" },
        { type: "image" },
        { type: "text", text: "changed after" },
      ],
    })
    const stored = await context.app.threadStore.readThread(childId)
    const childInput = stored?.rollout.find(
      ({ item }) =>
        item.type === "response_item" && item.item.item.role === "user",
    )?.item
    if (
      childInput?.type !== "response_item" ||
      childInput.item.item.role !== "user"
    )
      throw new Error("Missing child input")
    const copied = childInput.item.item.content.filter(
      (part) => part.type === "image",
    )
    expect(
      copied.map((part) => (part.file === undefined ? undefined : part.name)),
    ).toEqual(["second.png", "first.png"])
    expect(copied.map((part) => part.file?.rolloutId)).toEqual([
      childId,
      childId,
    ])
    const removed = await context.app.handlers.forkSession({
      sessionId: childId,
      atInputId: childInput.item.id,
      reason: "edit",
      modelSelection: { provider: "openai", model: "gpt-6-astra" },
      content: {
        kind: "parts",
        parts: [{ type: "text", text: "remove the images" }],
      },
    })
    if (!removed.ok) throw new Error(removed.body.error.message)
    await until(
      () =>
        context.app.threadManager.getThread(removed.body.session.id)?.status ===
        "idle",
    )
    expect(
      requests
        .at(-1)
        ?.messages.filter(
          (message) => message.role === "user" && message.context === undefined,
        )
        .at(-1),
    ).toEqual({
      role: "user",
      content: [{ type: "text", text: "remove the images" }],
    })
    expect(
      await context.app.handlers.deleteSession({ sessionId: id }),
    ).toMatchObject({ ok: true })
    for (const image of copied) {
      if (!image.file) throw new Error("Missing copied image reference")
      expect(await context.app.rolloutAssets.read(image.file)).toEqual(bytes)
    }
    await context.restart()
    await admit(context.app, childId, "fork_resume", "continue")
    expect(
      requests
        .at(-1)
        ?.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (part) => part.type === "text" && part.text === "changed before",
            ),
        ),
    ).toMatchObject({
      content: [
        { type: "text", text: "changed before" },
        { type: "image" },
        { type: "text", text: "changed middle" },
        { type: "image" },
        { type: "text", text: "changed after" },
      ],
    })
  })

  it("replays persisted legacy admission hashes without resampling or rewriting saved input", async () => {
    let calls = 0
    const context = await fixture(async function* () {
      calls++
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    })
    const id = await createMain(context.app)
    await admit(context.app, id, "saved_request", "saved prompt")
    let legacyBytes = ""
    const path = join(
      context.app.sessionStoreRoot,
      "rollouts",
      id,
      "rollout.jsonl",
    )
    await context.restart(async () => {
      const lines = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line): StoredRolloutItem => JSON.parse(line))
      legacyBytes = `${lines
        .map((line) =>
          JSON.stringify(
            line.item.type === "turn_started"
              ? {
                  ...line,
                  item: {
                    ...line.item,
                    requestFingerprint:
                      "f085c0727a70d11aba2b12534bf68f0cfc5dfb5d6fd07af216cdb6a84022ef49",
                  },
                }
              : line,
          ),
        )
        .join("\n")}\n`
      await writeFile(path, legacyBytes)
    })
    await admit(context.app, id, "saved_request", "saved prompt")
    expect(calls).toBe(1)
    expect(await readFile(path, "utf8")).toBe(legacyBytes)
    expect(
      await context.app.handlers.admitInput({
        sessionId: id,
        requestId: "saved_request",
        content: {
          kind: "parts",
          parts: [
            { type: "text", text: "saved" },
            { type: "text", text: " prompt" },
          ],
        },
      }),
    ).toMatchObject({ ok: false, status: 409 })
    expect(calls).toBe(1)
  })

  it.each([
    "saved-separate-images",
    "ordered",
  ] as const)("resumes %s user media into the same request order and attachment projection", async (shape) => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
    })
    const id = await createMain(context.app)
    const first = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer()
    const second = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#445566" },
    })
      .png()
      .toBuffer()
    const attachments = await context.app.rolloutAssets.importAttachmentBytes(
      id,
      "ordered_images",
      [
        { name: "first.png", data: first },
        { name: "second.png", data: second },
      ],
    )
    const admitted = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "ordered_first",
      modelSelection: { provider: "openai", model: "gpt-5" },
      content: {
        kind: "parts" as const,
        parts: [
          ...(shape === "ordered"
            ? attachments
                .slice(0, 1)
                .map((image) => ({ type: "image" as const, ...image }))
            : []),
          { type: "text" as const, text: "between images" },
          ...(shape === "ordered" ? attachments.slice(1) : attachments).map(
            (image) => ({ type: "image" as const, ...image }),
          ),
        ],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await until(
      () => context.app.threadManager.getThread(id)?.status === "idle",
    )
    await context.restart(async () => {
      if (shape === "ordered") return
      const path = join(
        context.app.sessionStoreRoot,
        "rollouts",
        id,
        "rollout.jsonl",
      )
      const entries = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line): StoredRolloutItem => JSON.parse(line))
      const rewritten = entries.map((entry) => {
        if (
          entry.item.type !== "response_item" ||
          entry.item.item.id !== admitted.body.inputId ||
          entry.item.item.item.role !== "user"
        )
          return entry
        const message = entry.item.item.item
        const images = message.content.filter((block) => block.type === "image")
        const [firstImage, secondImage] = images
        if (firstImage === undefined || secondImage === undefined)
          throw new Error("Missing saved images")
        const text = { type: "text", text: "between images" }
        return {
          ...entry,
          item: {
            ...entry.item,
            item: {
              ...entry.item.item,
              item: { role: "user", content: [text], images },
            },
          },
        }
      })
      await writeFile(
        path,
        `${rewritten.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      )
    })
    const continued = await context.app.handlers.admitInput({
      sessionId: id,
      requestId: "ordered_continue",
      modelSelection: { provider: "openai", model: "gpt-5" },
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "continue" }],
      },
    })
    if (!continued.ok) throw new Error(continued.body.error.message)
    await until(
      () => context.app.threadManager.getThread(id)?.status === "idle",
    )
    const original = requests
      .at(-1)
      ?.messages.find(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (block) => block.type === "text" && block.text === "between images",
          ),
      )
    if (original?.role !== "user")
      throw new Error("Missing resumed user content")
    expect(original.content.map((block) => block.type)).toEqual(
      shape === "ordered"
        ? ["image", "text", "image"]
        : ["text", "image", "image"],
    )
    const imageBlocks = original.content.filter(
      (block) => block.type === "image",
    )
    const pixels = await Promise.all(
      imageBlocks.map(async (block) => {
        if (block.data === undefined)
          throw new Error("Unresolved resumed image")
        const bytes = await sharp(Buffer.from(block.data, "base64"))
          .removeAlpha()
          .raw()
          .toBuffer()
        return [...bytes.subarray(0, 3)]
      }),
    )
    expect(pixels).toEqual([
      [17, 34, 51],
      [68, 85, 102],
    ])
    const events = await context.app.handlers.readSessionEvents({
      sessionId: id,
    })
    if (!events.ok) throw new Error(events.body.error.message)
    expect(
      events.body.events.find(
        (entry) =>
          entry.type === "input.admitted" &&
          entry.data.inputId === admitted.body.inputId,
      ),
    ).toMatchObject({
      data: {
        content: {
          kind: "parts",
          parts:
            shape === "ordered"
              ? [
                  {
                    type: "image",
                    name: "first.png",
                    file: {
                      rolloutId: id,
                      path: expect.stringContaining("attachments/requests/"),
                    },
                  },
                  { type: "text", text: "between images" },
                  {
                    type: "image",
                    name: "second.png",
                    file: {
                      rolloutId: id,
                      path: expect.stringContaining("attachments/requests/"),
                    },
                  },
                ]
              : [
                  { type: "text", text: "between images" },
                  {
                    type: "image",
                    name: "first.png",
                    file: {
                      rolloutId: id,
                      path: expect.stringContaining("attachments/requests/"),
                    },
                  },
                  {
                    type: "image",
                    name: "second.png",
                    file: {
                      rolloutId: id,
                      path: expect.stringContaining("attachments/requests/"),
                    },
                  },
                ],
        },
      },
    })
  })

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
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Fresh question" }],
      },
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
        latestUser.content.find((block) => block.type === "text")?.text ===
          "unfinished parent task"
      ) {
        yield { type: "delta", text: "unfinished parent answer" }
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
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "unfinished parent task" }],
      },
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
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain the decision only" }],
        contextAttachments: excerpts,
      },
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
      role: "user",
      content: {
        kind: "parts",
        parts: [{ type: "text", text: "Explain the decision only" }],
        contextAttachments: excerpts,
      },
    })
    const nested = await context.app.sideChats.create({
      sourceSessionId: side.id,
    })
    await context.app.sideChats.send({
      sideChatId: nested.id,
      requestId: "nested_first",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Explain the side answer" }],
      },
    })
    await until(
      () => context.app.sideChats.read(nested.id).activeTurnId === undefined,
    )
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "Explain the decision only",
    )
    expect(await context.app.threadStore.listThreadIds()).toEqual([id])
  })

  it.each([
    "user",
    "tool",
  ] as const)("keeps inherited %s images model-visible after closing an intermediate side chat", async (origin) => {
    const requests: ModelRequest[] = []
    const context = await fixture(async function* (request) {
      requests.push(request)
      if (origin === "tool" && requests.length === 1) {
        yield {
          type: "response",
          response: {
            stopReason: ModelStopReason.ToolUse,
            content: [
              {
                type: "tool_call",
                id: "parent_image",
                name: "view_image",
                input: { path: "parent.png" },
              },
            ],
          },
        }
        return
      }
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
    await writeFile(join(context.root, "parent.png"), bytes)
    const attachments =
      origin === "user"
        ? await context.app.rolloutAssets.importAttachmentBytes(
            parentId,
            "parent_image_draft",
            [{ name: "parent.png", data: bytes }],
          )
        : undefined
    const admitted = await context.app.handlers.admitInput({
      sessionId: parentId,
      requestId: "parent_image_turn",
      modelSelection: { provider: "openai", model: "gpt-5" },
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "Describe the parent image" },
          ...(attachments ?? []).map((image) => ({
            type: "image" as const,
            ...image,
          })),
        ],
      },
    })
    if (!admitted.ok) throw new Error(admitted.body.error.message)
    await until(
      () => context.app.threadManager.getThread(parentId)?.status === "idle",
    )
    const stored = await context.app.threadStore.readThread(parentId)
    const parentImage = stored?.rollout.flatMap(({ item }) =>
      item.type === "response_item" && item.item.item.role === origin
        ? item.item.item.content.filter((block) => block.type === "image")
        : [],
    )[0]
    if (parentImage?.type !== "image" || !parentImage.file)
      throw new Error("Missing stored parent image")
    const side = await context.app.sideChats.create({
      sourceSessionId: parentId,
    })
    expect(side.messages).toEqual([])
    await context.app.sideChats.send({
      sideChatId: side.id,
      requestId: "side_image_question",
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "Explain the image color only" },
        ],
      },
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
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "Explain the same image again" },
        ],
      },
    })
    await until(
      () => context.app.sideChats.read(nested.id).activeTurnId === undefined,
    )
    for (const request of requests.slice(origin === "tool" ? 2 : 1)) {
      const images = request.messages.flatMap((message) =>
        message.role === "user"
          ? message.content.filter((block) => block.type === "image")
          : [],
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
    const deleted = await context.app.handlers.deleteSession({
      sessionId: parentId,
    })
    if (!deleted.ok) throw new Error(deleted.body.error.message)
    await expect(
      context.app.rolloutAssets.read(parentImage.file),
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await context.app.threadStore.listThreadIds()).toEqual([])
    expect(() => context.app.sideChats.read(side.id)).toThrow(
      "no longer available",
    )
    expect(() => context.app.sideChats.read(nested.id)).toThrow(
      "no longer available",
    )
  })

  it("deleting a session closes active side chats and their nested descendants without closing independent chats", async () => {
    const cancelled: string[] = []
    const context = await fixture(async function* (request) {
      if (request.messages.some((message) => message.role === "user")) {
        yield { type: "delta", text: "working" }
        if (!request.signal) throw new Error("Expected cancellation signal")
        if (!request.signal.aborted)
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          )
        cancelled.push("active side chat")
        yield { type: "cancelled" }
      }
    })
    const parentId = await createMain(context.app)
    const side = await context.app.sideChats.create({
      sourceSessionId: parentId,
    })
    const nested = await context.app.sideChats.create({
      sourceSessionId: side.id,
    })
    const sibling = await context.app.sideChats.create({
      sourceSessionId: parentId,
    })
    const independent = await context.app.sideChats.create({})
    await context.app.sideChats.send({
      sideChatId: nested.id,
      requestId: "nested_active",
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Keep working" }],
      },
    })
    await until(() =>
      context.app.sideChats
        .read(nested.id)
        .messages.some(
          (message) =>
            message.role === "assistant" && message.text === "working",
        ),
    )
    const deleted = await context.app.handlers.deleteSession({
      sessionId: parentId,
    })
    if (!deleted.ok) throw new Error(deleted.body.error.message)
    expect(cancelled).toEqual(["active side chat"])
    for (const id of [side.id, nested.id, sibling.id]) {
      expect(() => context.app.sideChats.read(id)).toThrow(
        "no longer available",
      )
      await expect(
        context.app.sideChats.create({ sourceSessionId: id }),
      ).rejects.toMatchObject({ code: "not_found" })
    }
    expect(context.app.sideChats.read(independent.id).id).toBe(independent.id)
    expect(await context.app.threadStore.listThreadIds()).toEqual([])
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
      type: "import_attachment_paths",
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
      content: {
        kind: "parts" as const,
        parts: [
          { type: "text" as const, text: "Inspect the file" },
          ...imported.attachments.map((attachment) =>
            attachment.mediaType === "application/pdf"
              ? { type: "document" as const, ...attachment }
              : { type: "image" as const, ...attachment },
          ),
          { type: "text", text: " and image" },
        ],
      },
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
    expect(
      requests[0]?.messages.find(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text === "Inspect the file",
          ),
      ),
    ).toMatchObject({
      content: [
        { type: "text", text: "Inspect the file" },
        { type: "image" },
        { type: "text", text: " and image" },
      ],
    })
    const firstMessage = context.app.sideChats.read(side.id).messages[0]
    const attachment =
      firstMessage?.role === "user"
        ? firstMessage.content.parts.find((part) => part.type === "image")
        : undefined
    if (!attachment) throw new Error("Missing promoted attachment")
    expect(firstMessage).toMatchObject({
      role: "user",
      content: {
        kind: "parts",
        parts: [
          { type: "text", text: "Inspect the file" },
          { type: "image" },
          { type: "text", text: " and image" },
        ],
      },
    })
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
      content: {
        kind: "parts" as const,
        parts: [{ type: "text" as const, text: "Run the command" }],
      },
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
