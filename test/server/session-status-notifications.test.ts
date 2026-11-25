import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createUserInput } from "../../src/core/user-input.ts"
import {
  createAppRpcClient,
  type AppRpcClient,
} from "../../src/gui/lib/rpc-client.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import { MessageProcessor } from "../../src/server/rpc/message-processor.ts"

it("publishes one sidebar refresh per running transition for the affected session", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-status-notifications-"))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await createYakitoriApplication({
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "faux",
    model: "scripted",
    async *stream() {
      entered.resolve()
      await release.promise
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "Done" }],
        },
      }
    },
  })
  const broadcast = vi.spyOn(
    MessageProcessor.prototype,
    "broadcastNotification",
  )
  const server = app.createHttpServer()
  let client: AppRpcClient | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP address.")
    client = createAppRpcClient({ apiBase: `http://127.0.0.1:${address.port}` })
    const created = await app.handlers.createSession()
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.value.session.id
    broadcast.mockClear()
    const sidebarChanges = () =>
      broadcast.mock.calls
        .filter(([method]) => method === "sidebar/changed")
        .map(([, params]) => params)
    const admitted = await app.handlers.admitInput({
      sessionId,
      requestId: "request_status_notification",
      content: createUserInput("Start"),
    })
    if (!admitted.ok) throw new Error(admitted.error.message)
    await entered.promise
    await expect.poll(sidebarChanges).toEqual([{ sessionId }])
    const snapshot = await client.request("session/subscribe", {
      sessionId,
    })
    expect(snapshot).toMatchObject({
      activeTurn: {
        turnId: "request_status_notification",
        events: expect.arrayContaining([
          expect.objectContaining({ type: "input.admitted" }),
          expect.objectContaining({ type: "turn.started" }),
        ]),
      },
    })
    expect(snapshot.watermarkSeq).toBe(snapshot.session.seq)
    broadcast.mockClear()
    release.resolve()
    await expect.poll(() => app.threadManager.runningTurnCount).toBe(0)
    await expect.poll(sidebarChanges).toEqual([{ sessionId }])
    expect(broadcast.mock.calls).toContainEqual([
      "sessions/activity",
      { activeSessionIds: [] },
    ])
  } finally {
    release.resolve()
    client?.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await app.close()
    broadcast.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
