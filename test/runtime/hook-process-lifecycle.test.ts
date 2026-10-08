import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, expect, it, vi } from "vitest"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"

function runnerFor(command: string, timeoutMs = 10_000, asynchronous = false) {
  const handler = {
    type: "command" as const,
    command,
    timeoutMs,
    async: asynchronous,
  }
  return createHookRunner({
    UserPromptSubmit: [
      { hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }] },
    ],
  })
}
async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await readFile(path, "utf8").catch(() => undefined)
    if (value !== undefined) return value
    await delay(10)
  }
  throw new Error(`Hook did not create ${path}`)
}

describe.skipIf(process.platform === "win32")(
  "owned hook process groups",
  () => {
    for (const mode of ["abort", "timeout", "dispose"] as const) {
      it(`stops grandchildren on ${mode}, including SIGTERM-resistant children with closed pipes`, async () => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-hook-tree-"))
        const controller = new AbortController()
        const marker = join(root, "late")
        const ready = join(root, "ready")
        const script = join(root, "child.cjs")
        await writeFile(
          script,
          `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1600);`,
        )
        // Close the grandchild's pipes so leader/stdio exit cannot masquerade as
        // complete cleanup of a descendant that ignores SIGTERM.
        const runner = runnerFor(
          `sh -c '${JSON.stringify(process.execPath)} ${JSON.stringify(script)} >/dev/null 2>&1 & wait' & wait`,
          mode === "timeout" ? 600 : 10_000,
          mode === "dispose",
        )
        const result = runner
          .run({
            event: HookEvent.UserPromptSubmit,
            payload: {},
            cwd: root,
            signal: controller.signal,
          })
          .catch((error) => error)
        try {
          await waitForFile(ready)
          if (mode === "dispose") await runner.dispose()
          else if (mode === "abort") controller.abort()
          const outcome = await result
          if (mode === "abort")
            expect(outcome).toMatchObject({ name: "AbortError" })
          if (mode === "timeout") expect(outcome.message).toContain("timed out")
          await delay(1800)
          await expect(readFile(marker, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          })
        } finally {
          controller.abort()
          await runner.dispose()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
    it("retains the deadline after shell exit while a descendant holds pipes", async () => {
      const root = await mkdtemp(join(tmpdir(), "yakitori-hook-tree-"))
      const marker = join(root, "late")
      const script = join(root, "child.cjs")
      await writeFile(
        script,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1000)`,
      )
      const runner = runnerFor(
        `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} & exit 0`,
        250,
      )
      try {
        await expect(
          runner.run({
            event: HookEvent.UserPromptSubmit,
            payload: {},
            cwd: root,
          }),
        ).rejects.toThrow("timed out")
        await delay(1100)
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        })
      } finally {
        await runner.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
    it("preserves completed hooks' intentional helpers with redirected pipes", async () => {
      const root = await mkdtemp(join(tmpdir(), "yakitori-hook-tree-"))
      const marker = join(root, "completed")
      const script = join(root, "helper.cjs")
      await writeFile(
        script,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 150)`,
      )
      const runner = runnerFor(
        `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} >/dev/null 2>&1 & exit 0`,
      )
      try {
        await expect(
          runner.run({
            event: HookEvent.UserPromptSubmit,
            payload: {},
            cwd: root,
          }),
        ).resolves.toMatchObject({ continue: true })
        await expect(waitForFile(marker)).resolves.toBe("done")
      } finally {
        await runner.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
    it("does not execute an already-aborted request", async () => {
      const root = await mkdtemp(join(tmpdir(), "yakitori-hook-aborted-"))
      const marker = join(root, "started")
      const controller = new AbortController()
      controller.abort()
      const runner = runnerFor(`echo started > ${JSON.stringify(marker)}`)
      try {
        await expect(
          runner.run({
            event: HookEvent.UserPromptSubmit,
            payload: {},
            cwd: root,
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ name: "AbortError" })
        await delay(50)
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        })
      } finally {
        await runner.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
    it("allows a short real process to complete under a very long timeout", async () => {
      const runner = runnerFor(
        `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 50)'`,
        2_147_483_648,
      )
      try {
        await expect(
          runner.run({
            event: HookEvent.UserPromptSubmit,
            payload: {},
            cwd: process.cwd(),
          }),
        ).resolves.toMatchObject({ continue: true })
      } finally {
        await runner.dispose()
      }
    })
    for (const termination of ["deadline", "abort"] as const) {
      it(`preserves a timeout above Node's timer maximum until ${termination}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "yakitori-hook-deadline-"))
        const ready = join(root, "ready")
        const script = join(root, "hook.cjs")
        await writeFile(
          script,
          `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`,
        )
        const controller = new AbortController()
        const runner = runnerFor(
          `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
          2_147_483_648,
        )
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "performance"],
        })
        try {
          let settled = false
          const run = runner
            .run({
              event: HookEvent.UserPromptSubmit,
              payload: {},
              cwd: root,
              signal: controller.signal,
            })
            .catch((error) => error)
            .finally(() => {
              settled = true
            })
          await waitForFile(ready)
          await vi.advanceTimersByTimeAsync(
            termination === "abort" ? 100 : 2_147_483_647,
          )
          expect(settled).toBe(false)
          if (termination === "abort") {
            controller.abort()
            await vi.advanceTimersByTimeAsync(1000)
          } else await vi.advanceTimersByTimeAsync(1)
          const error = await run
          if (termination === "abort") expect(error.name).toBe("AbortError")
          else expect(error.message).toContain("timed out after 2147483648ms")
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
          controller.abort()
          await runner.dispose()
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  },
)
