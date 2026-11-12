import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createUserInput } from "../../src/core/user-input.ts"
import { ModelStopReason } from "../../src/runtime/model.ts"
import { createYakitoriApplication } from "../../src/server/application.ts"
import { MessageProcessor } from "../../src/server/rpc/message-processor.ts"

it("scopes running-transition sidebar notifications to the affected session", async () => {
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
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
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
    await expect.poll(sidebarChanges).not.toHaveLength(0)
    for (const params of sidebarChanges()) expect(params).toEqual({ sessionId })
    broadcast.mockClear()
    release.resolve()
    await expect.poll(() => app.threadManager.runningTurnCount).toBe(0)
    await expect.poll(sidebarChanges).not.toHaveLength(0)
    for (const params of sidebarChanges()) expect(params).toEqual({ sessionId })
    expect(broadcast.mock.calls).toContainEqual([
      "sessions/activity",
      { activeSessionIds: [] },
    ])
  } finally {
    release.resolve()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await app.close()
    broadcast.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
