import { spawn } from "node:child_process"
import { once } from "node:events"
import { describe, expect, it, onTestFinished } from "vitest"
import { createToolRegistry } from "../../../src/runtime/tools/registry.ts"
import type { RuntimeTool } from "../../../src/runtime/tools/types.ts"

describe("tool resource settlement", () => {
  it
    .skipIf(process.platform === "win32")
    .each(
      ["step", "registry"].flatMap((owner) =>
        [1, 2].map((failures) => ({ owner, failures })),
      ),
    )(
    "$owner cleanup waits for every process and preserves $failures failures across repeated calls",
    async ({ owner, failures }) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => { process.stdout.write('stopping\\n'); process.stdin.once('data', () => process.exit(0)); }); process.stdin.resume(); process.stdout.write('ready\\n');",
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      )
      const closed = once(child, "close")
      onTestFinished(async () => {
        child.kill("SIGKILL")
        await closed
      })
      await once(child.stdout, "data")
      const stopping = once(child.stdout, "data")
      const errors = Array.from(
        { length: failures },
        (_, i) => new Error(`Resource ${i} could not close`),
      )
      const tool = (name: string): RuntimeTool => ({
        toolName: { namespace: "owned", name },
        description: name,
        inputSchema: { type: "object" },
        effect: "opaque",
        approvalRequirement: { kind: "none" },
        async execute() {
          return { ok: true, content: name, output: name }
        },
      })
      const registry = createToolRegistry([])
      registry.replaceExternalSource("owned", [
        ...errors.map((error, i) => ({
          ...tool(`failed_${i}`),
          dispose() {
            throw error
          },
        })),
        {
          ...tool("process"),
          async dispose() {
            child.kill("SIGTERM")
            await closed
          },
        },
      ])
      const step =
        owner === "step"
          ? registry.finalize({
              enabledTrustedTools: new Set(),
              customToolMode: "function",
              wireProtocol: "eager",
            })
          : undefined
      if (step !== undefined) registry.replaceExternalSource("owned", [])
      const cleanup = () => step?.release() ?? registry.dispose()
      let firstState = "pending"
      let repeatedState = "pending"
      const first = cleanup().then(
        () => {
          firstState = "resolved"
        },
        (error: unknown) => {
          firstState = "rejected"
          return error
        },
      )
      const repeated = cleanup().then(
        () => {
          repeatedState = "resolved"
        },
        (error: unknown) => {
          repeatedState = "rejected"
          return error
        },
      )
      await stopping
      expect(firstState).toBe("pending")
      expect(repeatedState).toBe("pending")
      expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow()
      if (owner === "registry") {
        expect(() =>
          registry.replaceExternalSource("late", [tool("late")]),
        ).toThrow("disposed")
        expect(() =>
          registry.finalize({
            enabledTrustedTools: new Set(),
            customToolMode: "function",
            wireProtocol: "eager",
          }),
        ).toThrow("disposed")
      }
      child.stdin.end("release")
      await closed
      const failure = await first
      if (errors.length === 1) expect(failure).toBe(errors[0])
      else {
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure).toMatchObject({ errors })
      }
      expect(await repeated).toBe(failure)
      await expect(cleanup()).rejects.toBe(failure)
    },
  )
})
