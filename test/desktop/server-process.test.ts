import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  it("round-trips privileged attachment control over child IPC", async () => {
    const server = await spawnServerProcess({
      command: node,
      args: [
        "-e",
        `process.on("message", (message) => {
           process.send({ requestId: message.requestId, ok: true });
         });
         console.log("yakitori-listening http://127.0.0.1:1");
         setInterval(() => {}, 60000)`,
      ],
    })

    await expect(
      server.request({ type: "discard_draft_images", attachments: [] }),
    ).resolves.toMatchObject({ ok: true })

    await server.stop()
  })

  it.each([
    "desktop-entry.ts",
    "start.ts",
  ])("provides control IPC from the directly managed %s sidecar", async (entry) => {
    const workspace = await mkdtemp(join(tmpdir(), "yakitori-sidecar-test-"))
    let server: Awaited<ReturnType<typeof spawnServerProcess>> | undefined
    try {
      server = await spawnServerProcess({
        command: node,
        args: [join(process.cwd(), "src", "server", entry)],
        cwd: workspace,
        env: {
          ...process.env,
          PORT: "0",
          YAKITORI_PROVIDER: "faux",
          YAKITORI_STORE_DIR: join(workspace, ".yakitori"),
          YAKITORI_WORKSPACE: workspace,
        },
        onStderr: () => {},
      })

      await expect(
        server.request({
          type: "import_image_paths",
          sessionId: "session_missing",
          ownerId: "draft_missing",
          paths: [],
        }),
      ).resolves.toEqual({
        requestId: expect.any(String),
        ok: false,
        error: "Session session_missing was not found.",
      })
    } finally {
      await server?.stop()
      await rm(workspace, { recursive: true, force: true })
    }
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

  it("leaves a draining child alive until forceStop is requested", async () => {
    const server = await spawnServerProcess({
      command: node,
      args: [
        "-e",
        `process.on("SIGTERM", () => {});
         console.log("yakitori-listening http://127.0.0.1:1");
         setInterval(() => {}, 60000)`,
      ],
    })

    let stopped = false
    const stopping = server.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(stopped).toBe(false)
    await server.forceStop()
    await stopping
    expect(server.child.signalCode).toBe("SIGKILL")
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
    })

    await server.stop()

    expect(server.child.exitCode).toBe(0)
  })
})
