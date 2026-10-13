import { bindExecution } from "../support/session-execution.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { JsonlThreadStore } from "../../src/core/jsonl-thread-store.ts"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { ThreadManager } from "../../src/core/thread-manager.ts"
import { createUserInput } from "../../src/core/user-input.ts"
import { draftToEditorParts } from "../../src/gui/input-draft.ts"
import { fingerprintOperation } from "../../src/kernel/operation.ts"
import { SessionConfiguration } from "../../src/runtime/session-configuration.ts"
import { createThreadServerHandlers } from "../../src/server/handlers.ts"
import { InputQueue } from "../../src/server/input-queue.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("stored input recovery", () => {
  it.each([
    "parts",
    "text",
  ] as const)("restores %s input, editor positions and references without rewriting history or repeating an accepted queued request", async (format) => {
    const f = await recoveryFixture(format)
    f.writeQueue("request_saved")
    const originalBytes = await readFile(f.rolloutPath, "utf8")
    const queued = f.queue.list(f.id)[0]
    expect(queued?.input.content).toEqual(f.expected)
    const detail = await f.handlers.readSession({ sessionId: f.id })
    expect(detail).toMatchObject({ ok: true })
    const events = await f.handlers.readSessionEvents({ sessionId: f.id })
    if (!events.ok) throw new Error(events.error.message)
    const admission = events.value.events.find(
      (event) => event.type === "input.admitted",
    )
    expect(admission).toMatchObject({ data: { content: f.expected } })
    expect(draftToEditorParts(f.expected)).toEqual(
      format === "parts"
        ? [
            { type: "text", text: "👀before " },
            { type: "image", ...f.image, detail: "high" },
            { type: "text", text: " after" },
          ]
        : [
            { type: "text", text: "👀before after" },
            { type: "image", ...f.image, detail: "high" },
          ],
    )
    const retry = await f.handlers.admitInput({
      sessionId: f.id,
      requestId: "request_saved",
      content: f.expected,
      metadata: { source: "saved" },
    })
    expect(retry).toMatchObject({ ok: false, error: { code: "conflict" } })
    await expect.poll(() => f.queue.list(f.id).length).toBe(0)
    expect(f.runs()).toBe(0)
    expect(await readFile(f.rolloutPath, "utf8")).toBe(originalBytes)
    expect(await f.assets.read(f.image.file)).toEqual(f.png)
    const thread = f.manager.getThread(f.id)
    if (thread === undefined) throw new Error("Missing resumed thread")
    expect(
      await thread.startIfIdle({
        submissionId: "request_saved",
        content: { ...f.expected, text: `${f.expected.text}!` },
        metadata: { source: "saved" },
      }),
    ).toEqual({ type: "not_submitted", reason: "request_conflict" })
    expect(
      await thread.startIfIdle({
        submissionId: "request_saved",
        content: f.expected,
        metadata: { source: "changed" },
      }),
    ).toEqual({ type: "not_submitted", reason: "request_conflict" })
  })

  it("dispatches a retired queued input once and writes its authored draft in the current format", async () => {
    const f = await recoveryFixture("parts")
    f.writeQueue("request_pending")
    await f.manager.resumeThread(f.id)
    expect(await f.handlers.readSession({ sessionId: f.id })).toMatchObject({
      ok: true,
    })
    await expect.poll(() => f.runs()).toBe(1)
    await expect.poll(() => f.queue.list(f.id).length).toBe(0)
    await expect
      .poll(async () =>
        (await f.store.readThread(f.id))?.rollout.some(
          ({ item }) =>
            item.type === "turn_completed" && item.turnId === "request_pending",
        ),
      )
      .toBe(true)
    const saved = await f.store.readThread(f.id)
    const admitted = saved?.rollout.find(
      ({ item }) =>
        item.type === "response_item" && item.item.turnId === "request_pending",
    )?.item
    expect(admitted).toMatchObject({
      type: "response_item",
      item: { submissionMetadata: { content: f.expected } },
    })
    expect(f.runs()).toBe(1)
  })

  it("reserves a recorded human ID without requiring a replay fingerprint", async () => {
    const f = await recoveryFixture("parts", false)
    const thread = await f.manager.resumeThread(f.id)
    expect(
      await thread?.startIfIdle({
        submissionId: "request_saved",
        content: f.expected,
      }),
    ).toEqual({ type: "not_submitted", reason: "request_conflict" })
    expect(f.runs()).toBe(0)
  })

  it("replays a recorded automatic goal continuation without re-executing its work", async () => {
    const f = await recoveryFixture("parts")
    const thread = await f.manager.resumeThread(f.id)
    if (!thread) throw new Error("Missing thread")
    const input = {
      submissionId: "request_goal",
      content: createUserInput("finish the task"),
      goalId: "goal_saved",
    }
    const accepted = await thread.startIfIdle(input)
    await expect.poll(() => thread.agentStatus).toEqual({ completed: null })
    await f.manager.closeThread(f.id)
    const resumed = await f.manager.resumeThread(f.id)
    expect(await resumed?.startIfIdle(input)).toMatchObject({
      type: "replayed",
      turnId: "request_goal",
    })
    expect(accepted.type).toBe("started")
    expect(f.runs()).toBe(1)
  })
})

async function recoveryFixture(
  format: "parts" | "text",
  fingerprint = true,
  steer = false,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-stored-input-"))
  const id = "session_00000000-0000-4000-8000-000000000000"
  const store = new JsonlThreadStore({ root })
  const queuePath = join(root, "input-queue.sqlite")
  const queue = new InputQueue(queuePath)
  const assets = createRolloutAssets(root, {
    withMutationLease: (rolloutId, mutate) =>
      store.withRolloutAssetMutation(rolloutId, mutate),
  })
  let runs = 0
  const manager = new ThreadManager({
    store,
    createTurnProcessor: () => ({
      dispose() {},
      createTask(snapshot, input) {
        const context = ((_snapshot, input) => {
          const selection = { provider: "faux", model: "scripted" }
          return {
            turnId: input.submissionId,
            selection,
            configuration: SessionConfiguration.create({
              selection,
              workspaceRoot: root,
              enabledTools: [],
              approvalPolicy: "always_approve",
              promptCacheKey: input.submissionId,
            }).snapshot,
          }
        })(snapshot, input)
        let stop: (() => void) | undefined
        return {
          kind: input.manualCompact === true ? "compact" : "regular",
          async run(session, execution) {
            await session.beginExecution(execution, context)
            const runtime = bindExecution(session, execution)

            const task = (() => {
              runs++
              return { completion: runtime.recordInitialInput(), abort() {} }
            })()
            stop = task.abort
            return (await task.completion) ?? undefined
          },
          async abort() {
            stop?.()
          },
        }
      },
    }),
  })
  const handlers = createThreadServerHandlers({
    store,
    manager,
    inputQueue: queue,
    rolloutAssets: assets,
  })
  cleanups.push(async () => {
    await handlers.close()
    await manager.shutdown()
    queue.close()
    await rm(root, { recursive: true, force: true })
  })
  const now = new Date().toISOString()
  await store.createThread({
    id,
    conversationId: id,
    createdAt: now,
    updatedAt: now,
  })
  await store.persistThread(id, "turn_start")
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(1, 16)
  png.writeUInt32BE(1, 20)
  const staged = await assets.importAttachmentBytes(id, "saved", [
    { name: "old.png", data: png },
  ])
  const image = (await assets.promoteAttachments(id, "request_saved", staged))
    .attachments[0]
  if (image === undefined || image.mediaType === "application/pdf")
    throw new Error("Missing fixture image")
  const references = [
    {
      id: "annotation_saved",
      kind: "annotation" as const,
      text: "selected answer",
      comment: "my feedback",
      source: {
        kind: "message" as const,
        label: "Assistant",
        messageId: "item_previous",
      },
      anchor: { startOffset: 2, endOffset: 17 },
    },
  ]
  const parts =
    format === "parts"
      ? [
          { type: "text" as const, text: "👀before" },
          { type: "text" as const, text: " " },
          { type: "image" as const, ...image },
          { type: "text" as const, text: " after" },
        ]
      : [
          { type: "text" as const, text: "👀before after" },
          { type: "image" as const, ...image },
        ]
  const legacy =
    format === "parts"
      ? { kind: "parts", parts, contextAttachments: references }
      : {
          kind: "text",
          text: "👀before after",
          attachments: [image],
          contextAttachments: references,
        }
  await store.appendItems(id, [
    {
      type: "turn_started",
      turnId: "request_saved",
      inputItemId: "input_saved",
      ...(fingerprint
        ? {
            requestFingerprint: fingerprintOperation({
              role: "user",
              content: legacy,
              parentInputId: null,
              metadata: { source: "saved" },
            }),
          }
        : {}),
    },
    {
      type: "response_item",
      item: {
        id: "input_saved",
        turnId: "request_saved",
        createdAt: now,
        item: { role: "user", content: parts, contextAttachments: references },
        submissionMetadata: { metadata: { source: "saved" } },
      },
    },
    ...(steer
      ? [
          {
            type: "response_item" as const,
            item: {
              id: "message_saved_steer",
              turnId: "request_steer",
              createdAt: now,
              item: {
                role: "user" as const,
                content: [{ type: "text" as const, text: "steered" }],
              },
            },
          },
        ]
      : []),
    { type: "turn_completed", turnId: "request_saved", outcome: "completed" },
  ])
  await store.shutdownThread(id)
  const expected = createUserInput(
    format === "parts" ? "👀before [Image 1] after" : "👀before after[Image 1]",
    [{ ...image, detail: "high" }],
    [
      {
        startOffset: format === "parts" ? 9 : 14,
        endOffset: format === "parts" ? 18 : 23,
        attachmentIndex: 0,
      },
    ],
    references,
  )
  return {
    id,
    store,
    queue,
    assets,
    manager,
    handlers,
    image,
    png,
    expected,
    rolloutPath: join(root, "rollouts", id, "rollout.jsonl"),
    runs: () => runs,
    writeQueue(requestId: string) {
      const raw = new DatabaseSync(queuePath)
      try {
        raw
          .prepare(
            `INSERT INTO input_queue (id,session_id,request_id,input_json,queue_order,created_at) VALUES (?,?,?,?,?,?)`,
          )
          .run(
            "input_queue_saved",
            id,
            requestId,
            JSON.stringify({
              submissionId: requestId,
              content: legacy,
              metadata: { source: "saved" },
            }),
            0,
            now,
          )
      } finally {
        raw.close()
      }
    },
  }
}
