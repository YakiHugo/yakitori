import { spawn } from "node:child_process"
import { expect, it, vi } from "vitest"
import {
  createHookRunner,
  HookEvent,
  hookHandlerHash,
} from "../../src/runtime/hooks.ts"

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("A cancelled hook must not launch a process.")
  }),
}))

it("does not launch a command for an already cancelled hook request", async () => {
  const handler = { type: "command" as const, command: "exit 0" }
  const runner = createHookRunner({
    PreToolUse: [
      { hooks: [{ ...handler, trustedHash: hookHandlerHash(handler) }] },
    ],
  })
  const controller = new AbortController()
  controller.abort()

  await expect(
    runner.run({
      event: HookEvent.PreToolUse,
      payload: {},
      cwd: process.cwd(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(spawn).not.toHaveBeenCalled()
  await runner.dispose()
})
