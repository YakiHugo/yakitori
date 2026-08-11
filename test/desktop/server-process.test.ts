import { describe, expect, it } from "vitest"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"

const node = process.execPath

describe("spawnServerProcess", () => {
  it("parses the listening line out of surrounding log noise", async () => {
    const server = await spawnServerProcess({
      command: node,
      args: [
        "-e",
        `console.log("boot noise");
         console.log("yakitori-listening http://127.0.0.1:45678");
         console.log("trailing noise");
         setInterval(() => {}, 60000)`,
      ],
    })

    expect(server.url).toBe("http://127.0.0.1:45678")

    await server.stop()
  })

  it("rejects and kills the child when no listening line arrives in time", async () => {
    const started = Date.now()
    await expect(
      spawnServerProcess({
        command: node,
        args: ["-e", "setInterval(() => {}, 60000)"],
        timeoutMs: 300,
      }),
    ).rejects.toThrow("did not report a listening URL")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("rejects when the child exits before listening", async () => {
    await expect(
      spawnServerProcess({
        command: node,
        args: ["-e", `console.error("boom"); process.exit(3)`],
        onStderr: () => {},
      }),
    ).rejects.toThrow("exited before listening (code 3")
  })

  it("escalates SIGTERM to SIGKILL for a child that traps termination", async () => {
    const server = await spawnServerProcess({
      command: node,
      args: [
        "-e",
        `process.on("SIGTERM", () => {});
         console.log("yakitori-listening http://127.0.0.1:1");
         setInterval(() => {}, 60000)`,
      ],
      termToKillMs: 200,
    })

    const started = Date.now()
    await server.stop()

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(server.child.exitCode === null || server.child.killed).toBe(true)
  })

  it("stops a well-behaved child with SIGTERM alone", async () => {
    const server = await spawnServerProcess({
      command: node,
      args: [
        "-e",
        `process.on("SIGTERM", () => process.exit(0));
         console.log("yakitori-listening http://127.0.0.1:1");
         setInterval(() => {}, 60000)`,
      ],
      termToKillMs: 1_000,
    })

    await server.stop()

    expect(server.child.exitCode).toBe(0)
  })
})
