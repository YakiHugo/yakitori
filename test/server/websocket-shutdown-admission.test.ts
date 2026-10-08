import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import { ModelStopReason } from "../../src/runtime/model.ts"
import type { YakitoriApplication } from "../../src/server/application.ts"
import { runYakitoriServerProcess } from "../../src/server/server-process.ts"
import { inputFixture } from "../fixtures/user-input.ts"
import { deferred } from "./rpc/testkit.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6jYAAAAAASUVORK5CYII=",
  "base64",
)

describe("WebSocket admissions during graceful shutdown", () => {
  it("drains an admitted attachment input and its turn before stopping the application", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-ws-shutdown-"))
    const listening = deferred<{ url: string; app: YakitoriApplication }>()
    const promotionStarted = deferred<void>()
    const promotionMayFinish = deferred<void>()
    const turnStarted = deferred<void>()
    const turnMayFinish = deferred<void>()
    let cancelled = false
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    let socket: WebSocket | undefined
    let run: Promise<void> | undefined
    let signalled = false
    let restorePromotion: (() => void) | undefined
    let restoreBeginShutdown: (() => void) | undefined
    try {
      run = runYakitoriServerProcess({
        host: "127.0.0.1",
        port: 0,
        application: {
          rootDir: join(root, "state"),
          workspace: root,
          userConfigPath: join(root, "config.toml"),
          provider: "faux",
          model: "faux-test",
          async *stream(request) {
            turnStarted.resolve()
            await Promise.race([
              turnMayFinish.promise,
              new Promise<void>((resolve) => {
                if (request.signal?.aborted) resolve()
                else
                  request.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  })
              }),
            ])
            cancelled = request.signal?.aborted ?? false
            if (cancelled) yield { type: "cancelled" }
            else
              yield {
                type: "response",
                response: {
                  stopReason: ModelStopReason.EndTurn,
                  content: [{ type: "text", text: "completed normally" }],
                },
              }
          },
        },
        onListening: (url, app) => listening.resolve({ url, app }),
      })
      const { url, app } = await listening.promise
      const created = await app.handlers.createSession({})
      if (!created.ok) throw new Error(created.body.error.message)
      const sessionId = created.body.session.id
      const [draft] = await app.rolloutAssets.importAttachmentBytes(
        sessionId,
        "draft",
        [{ name: "image.png", data: png }],
      )
      if (draft === undefined) throw new Error("Missing draft")
      const promote = app.rolloutAssets.promoteAttachments.bind(
        app.rolloutAssets,
      )
      const promotionSpy = vi
        .spyOn(app.rolloutAssets, "promoteAttachments")
        .mockImplementation(async (...args) => {
          const result = await promote(...args)
          promotionStarted.resolve()
          await promotionMayFinish.promise
          return result
        })
      restorePromotion = () => promotionSpy.mockRestore()
      const begin = vi.spyOn(app.threadManager, "beginShutdown")
      restoreBeginShutdown = () => begin.mockRestore()
      socket = new WebSocket(`${url.replace("http:", "ws:")}/rpc`)
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve)
        socket?.once("error", reject)
      })
      const initialized = new Promise<void>((resolve) =>
        socket?.once("message", () => resolve()),
      )
      socket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "test", version: "1" } },
        }),
      )
      await initialized
      socket.send(
        JSON.stringify({
          id: 2,
          method: "session/input",
          params: {
            sessionId,
            requestId: "request_admitted_before_signal",
            content: inputFixture([
              { type: "text", text: "Explain this image" },
              { type: "image", ...draft },
            ]),
          },
        }),
      )
      await promotionStarted.promise
      expect(app.threadManager.runningTurnCount).toBe(0)
      process.emit("SIGINT")
      signalled = true
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect.soft(begin).not.toHaveBeenCalled()
      promotionMayFinish.resolve()
      await Promise.race([
        turnStarted.promise,
        run.then(() => {
          throw new Error("Server exited before the admitted turn began.")
        }),
      ])
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect.soft(exit).not.toHaveBeenCalled()
      expect.soft(begin).not.toHaveBeenCalled()
      turnMayFinish.resolve()
      await run
      expect(cancelled).toBe(false)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      promotionMayFinish.resolve()
      turnMayFinish.resolve()
      if (!signalled && run !== undefined) process.emit("SIGINT")
      await run
      socket?.terminate()
      restorePromotion?.()
      restoreBeginShutdown?.()
      exit.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
