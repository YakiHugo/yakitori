import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"
import { pdfFixture } from "../runtime/tools/pdf-fixture.ts"

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
      server.request({ type: "discard_draft_attachments", attachments: [] }),
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
          type: "import_attachment_paths",
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

  it("validates actual PDF snapshots and byte commands over the live sidecar", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "yakitori-pdf-sidecar-test-"),
    )
    let server: Awaited<ReturnType<typeof spawnServerProcess>> | undefined
    const storage = join(workspace, ".yakitori")
    const pdf = pdfFixture(["First page", "Second page"])
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    )
    try {
      server = await spawnServerProcess({
        command: node,
        args: [join(process.cwd(), "src", "server", "desktop-entry.ts")],
        cwd: workspace,
        env: {
          ...process.env,
          PORT: "0",
          YAKITORI_PROVIDER: "faux",
          YAKITORI_STORE_DIR: storage,
          YAKITORI_WORKSPACE: workspace,
        },
        onStderr: () => {},
      })
      const pdfPath = join(workspace, "report.png")
      const pngPath = join(workspace, "shot.pdf")
      await writeFile(pdfPath, pdf)
      await writeFile(pngPath, png)
      const picked = await server.request({
        type: "import_attachment_paths",
        rolloutId: "draft_mixed",
        ownerId: "draft_paths",
        paths: [pdfPath, pngPath],
      })
      expect(picked).toMatchObject({
        ok: true,
        attachments: [
          {
            name: "report.png",
            mediaType: "application/pdf",
            sizeBytes: pdf.byteLength,
          },
          {
            name: "shot.pdf",
            mediaType: "image/png",
            sizeBytes: png.byteLength,
          },
        ],
      })
      if (!picked.ok || picked.attachments === undefined)
        throw new Error("Import failed")
      const storedPdf = picked.attachments[0]
      if (storedPdf === undefined) throw new Error("No PDF attachment")
      expect(storedPdf).not.toHaveProperty("pageCount")
      expect(storedPdf).not.toHaveProperty("detail")
      const pdfUrl = `${server.url}/rollouts/${storedPdf.file.rolloutId}/assets/${storedPdf.file.path}`
      await writeFile(pdfPath, "%PDF-1.4\ninvalid")
      const stored = await fetch(pdfUrl)
      expect(stored.status).toBe(200)
      expect(stored.headers.get("content-type")).toContain("application/pdf")
      expect(Buffer.from(await stored.arrayBuffer())).toEqual(pdf)

      const pasted = await server.request({
        type: "import_attachment_bytes",
        rolloutId: "draft_mixed",
        ownerId: "draft_bytes",
        items: [{ name: "pasted.pdf", data: new Uint8Array(pdf) }],
      })
      expect(pasted).toMatchObject({
        ok: true,
        attachments: [{ name: "pasted.pdf", mediaType: "application/pdf" }],
      })
      if (!pasted.ok || pasted.attachments === undefined)
        throw new Error("Byte import failed")

      const invalid = await server.request({
        type: "import_attachment_bytes",
        rolloutId: "draft_mixed",
        ownerId: "draft_invalid",
        items: [
          { name: "valid.pdf", data: new Uint8Array(pdf) },
          {
            name: "broken.pdf",
            data: new Uint8Array(Buffer.from("%PDF-1.4\ninvalid")),
          },
        ],
      })
      expect(invalid).toMatchObject({ ok: false })
      await expect(
        stat(
          join(
            storage,
            "rollouts",
            "draft_mixed",
            "files",
            "attachments",
            "staging",
            "draft_invalid",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" })

      expect(
        await server.request({
          type: "discard_draft_attachments",
          attachments: [...picked.attachments, ...pasted.attachments],
        }),
      ).toMatchObject({ ok: true })
      expect((await fetch(pdfUrl)).status).toBe(404)
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
