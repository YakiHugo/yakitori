import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { createAttachmentUploads } from "../../src/server/attachment-uploads.ts"
import { createYakitoriHttpServer } from "../../src/server/http.ts"
import { createRequestGate } from "../../src/server/request-gate.ts"
import { createFakeHandlers } from "./rpc/testkit.ts"
import type { UserAttachment } from "../../src/protocol/asset-types.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rWQAAAAASUVORK5CYII=",
  "base64",
)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  options: {
    allowedOrigins?: readonly string[]
    validateImage?: (bytes: Uint8Array) => Promise<void>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-upload-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const incoming = join(root, "incoming")
  await mkdir(incoming)
  await writeFile(join(incoming, "crashed-upload"), png)
  const assets = createRolloutAssets(root, {
    withMutationLease: async (id, mutate) => {
      await mkdir(join(root, "rollouts", id), { recursive: true })
      return mutate()
    },
    ...(options.validateImage === undefined
      ? {}
      : { validateImage: options.validateImage }),
  })
  const released: string[] = []
  const uploads = await createAttachmentUploads({
    rolloutAssets: assets,
    temporaryDirectory: incoming,
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: options.allowedOrigins }),
    releaseDraftRolloutAssets: (ids) => {
      released.push(...ids)
    },
  })
  const gate = createRequestGate()
  const failures: unknown[] = []
  const server = createYakitoriHttpServer({
    reportOperationalFailure: (failure) => {
      failures.push(failure)
    },
    requestGate: gate,
    handlers: createFakeHandlers(),
    rolloutAssets: assets,
    attachmentUploads: uploads,
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const path = (id: string) => `${base}/attachments/uploads/${id}`
  const put = (
    id = randomUUID(),
    body: Uint8Array = png,
    name = "原图.png",
    headers: Record<string, string> = {},
  ) =>
    fetch(path(id), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Yakitori-Attachment": "upload",
        "X-Attachment-Name": encodeURIComponent(name),
        ...headers,
      },
      body: Uint8Array.from(body),
    })
  const discard = (id: string) =>
    fetch(path(id), {
      method: "DELETE",
      headers: { "X-Yakitori-Attachment": "upload" },
    })
  return {
    root,
    incoming,
    assets,
    uploads,
    released,
    base,
    path,
    put,
    discard,
    gate,
    failures,
  }
}

async function attachment(response: Response): Promise<UserAttachment> {
  expect(response.status).toBe(200)
  return ((await response.json()) as { attachment: UserAttachment }).attachment
}

describe("binary attachment uploads", () => {
  it("stores exact original bytes under a server-owned draft reference, replays, and preserves admitted copies on discard", async () => {
    const f = await fixture()
    const id = randomUUID()
    const first = await attachment(await f.put(id))
    expect(first.name).toBe("原图.png")
    expect(first.file).toEqual({
      rolloutId: `draft_upload_${id.replaceAll("-", "")}`,
      path: "attachments/staging/upload/1.png",
    })
    expect(await f.assets.read(first.file)).toEqual(png)
    if (process.platform !== "win32")
      expect((await stat(f.assets.resolve(first.file))).mode & 0o777).toBe(
        0o600,
      )
    expect(await attachment(await f.put(id))).toEqual(first)
    const admitted = await f.assets.copyAttachments(
      "rollout_session",
      "request_1",
      [first],
    )
    expect(
      (
        await fetch(f.path(id), {
          method: "DELETE",
          headers: { "X-Yakitori-Attachment": "upload" },
          body: "unexpected",
        })
      ).status,
    ).toBe(400)
    expect(await f.assets.read(first.file)).toEqual(png)
    expect((await f.discard(id)).status).toBe(204)
    expect((await f.discard(id)).status).toBe(204)
    await expect(f.assets.read(first.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
    const accepted = admitted.attachments[0]
    if (!accepted) throw new Error("Missing admitted attachment")
    expect(await f.assets.read(accepted.file)).toEqual(png)
    expect(await readdir(f.incoming)).toEqual([])
  })

  it("rejects changed-name and changed-byte replays without deleting the earlier successful draft", async () => {
    const f = await fixture()
    const id = randomUUID()
    const first = await attachment(await f.put(id))
    expect((await f.put(id, png, "different.png")).status).toBe(409)
    expect(
      (await f.put(id, Buffer.concat([png, Buffer.from("changed")]))).status,
    ).toBe(409)
    expect(await f.assets.read(first.file)).toEqual(png)
  })

  it("rejects invalid media and cleans all temporary and staged files", async () => {
    const f = await fixture()
    const id = randomUUID()
    expect((await f.put(id, Buffer.from("not an image"))).status).toBe(400)
    expect(await readdir(f.incoming)).toEqual([])
    expect(await readdir(join(f.root, "rollouts"))).toEqual([])
    expect(await attachment(await f.put(id))).toMatchObject({
      sizeBytes: png.length,
    })
  })

  it("scopes DELETE to upload IDs, never supplied rollout IDs, paths or references", async () => {
    const f = await fixture()
    const [other] = await f.assets.importAttachmentBytes(
      "draft_desktop",
      "owner",
      [{ name: "other.png", data: png }],
    )
    for (const path of [
      "draft_desktop",
      "../draft_desktop",
      "session_123",
      `${randomUUID()}?path=../../secret`,
    ])
      expect(
        (
          await fetch(`${f.base}/attachments/uploads/${path}`, {
            method: "DELETE",
            headers: { "X-Yakitori-Attachment": "upload" },
          })
        ).status,
      ).toBe(404)
    if (!other) throw new Error("Missing unrelated attachment")
    expect(await f.assets.read(other.file)).toEqual(png)
  })

  it("rejects simple form writes, untrusted Origin/Host, and origin-less cross-site browser traffic", async () => {
    const f = await fixture()
    expect(
      (await f.put(undefined, png, "a.png", { "Content-Type": "text/plain" }))
        .status,
    ).toBe(415)
    expect(
      (await f.put(undefined, png, "a.png", { "X-Yakitori-Attachment": "" }))
        .status,
    ).toBe(403)
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:5173",
      "http://127.0.0.1:54321",
    ])
      expect(
        (await f.put(undefined, png, "a.png", { Origin: origin })).status,
      ).toBe(403)
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        f.path(randomUUID()),
        {
          method: "PUT",
          headers: { Host: "evil.example", "X-Yakitori-Attachment": "upload" },
        },
        (res) => {
          resolve(res.statusCode)
          res.resume()
        },
      )
      req.on("error", reject)
      req.end()
    })
    expect(badHost).toBe(403)
    expect(
      (await f.put(undefined, png, "a.png", { "Sec-Fetch-Site": "cross-site" }))
        .status,
    ).toBe(403)
    expect(
      (await f.put(undefined, png, "a.png", { Origin: f.base })).status,
    ).toBe(200)
    expect(await readdir(f.incoming)).toEqual([])
  })

  it("allows only explicitly configured development origins including their preflight", async () => {
    const origin = "http://127.0.0.1:5173"
    const f = await fixture({ allowedOrigins: [origin] })
    const preflight = await fetch(f.path(randomUUID()), {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers":
          "content-type,x-yakitori-attachment,x-attachment-name",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin)
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    )
    expect(
      (await f.put(undefined, png, "a.png", { Origin: origin })).status,
    ).toBe(200)
  })

  it("rejects filename traversal and an oversized declared body before importing", async () => {
    const f = await fixture()
    for (const name of [
      "../secret",
      "C:\\secret",
      ".",
      "a\u0000.png",
      "x".repeat(256),
    ])
      expect((await f.put(undefined, png, name)).status).toBe(400)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        f.path(randomUUID()),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Yakitori-Attachment": "upload",
            "X-Attachment-Name": "a.png",
            "Content-Length": "50000001",
          },
        },
        (res) => {
          resolve(res.statusCode)
          res.resume()
        },
      )
      req.on("error", reject)
      req.flushHeaders()
    })
    expect(status).toBe(413)
    expect(await readdir(f.incoming)).toEqual([])
  })

  it("serializes same-handle deletion after validation", async () => {
    let entered!: () => void
    let unblock!: () => void
    const validating = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const f = await fixture({
      validateImage: async () => {
        entered()
        await blocked
      },
    })
    const id = randomUUID()
    const upload = f.put(id)
    await validating
    const deletion = f.discard(id)
    unblock()
    const first = await attachment(await upload)
    expect((await deletion).status).toBe(204)
    await expect(f.assets.read(first.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readdir(f.incoming)).toEqual([])
  })

  it("cleans disconnected streaming bodies and rejects bodies that cross the streaming bound", async () => {
    const f = await fixture()
    const id = randomUUID()
    await new Promise<void>((resolve) => {
      const req = httpRequest(f.path(id), {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Yakitori-Attachment": "upload",
          "X-Attachment-Name": "a.png",
        },
      })
      req.on("error", () => resolve())
      req.write(png)
      setTimeout(() => req.destroy(new Error("cancelled")), 30)
    })
    await expect.poll(async () => readdir(f.incoming)).toEqual([])
    const first = await attachment(await f.put(id))
    expect(await f.assets.read(first.file)).toEqual(png)
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        f.path(randomUUID()),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Yakitori-Attachment": "upload",
            "X-Attachment-Name": "a.png",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(413)
          res.resume()
          resolve()
        },
      )
      req.on("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNRESET" || error.code === "EPIPE"
          ? resolve()
          : reject(error),
      )
      req.setHeader("Transfer-Encoding", "chunked")
      expect(req.getHeader("Content-Length")).toBeUndefined()
      req.end(Buffer.alloc(50_000_001))
    })
    await expect.poll(async () => readdir(f.incoming)).toEqual([])
  })
  it("bounds active uploads and pending drafts, reclaiming slots on explicit deletion", async () => {
    let entered = 0
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const f = await fixture({
      validateImage: async () => {
        entered++
        await blocked
      },
    })
    const ids = Array.from({ length: 4 }, () => randomUUID())
    const uploads = ids.map((id) => f.put(id))
    await expect.poll(() => entered).toBe(4)
    expect((await f.put()).status).toBe(429)
    unblock()
    for (const upload of uploads) await attachment(await upload)
    for (const id of ids) expect((await f.discard(id)).status).toBe(204)
    for (let index = 0; index < 200; index++) await attachment(await f.put())
    expect((await f.put()).status).toBe(429)
  })

  it("does not resurrect a draft released by admission during an upload replay", async () => {
    let block = false
    let entered!: () => void
    let unblock!: () => void
    const validating = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const f = await fixture({
      validateImage: async () => {
        if (block) {
          entered()
          await blocked
        }
      },
    })
    const id = randomUUID()
    const first = await attachment(await f.put(id))
    block = true
    const replay = f.put(id)
    await validating
    if ("url" in first.file) throw new Error("Expected stored attachment")
    f.uploads.release([first.file.rolloutId])
    unblock()
    expect((await replay).status).toBe(409)
    await expect(f.assets.read(first.file)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
  it("closes a stalled chunked upload at its deadline and drains the request gate after cleanup", async () => {
    const f = await fixture()
    const schedule = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, delay, ...args) =>
        schedule(callback, delay === 120_000 ? 25 : delay, ...args),
    )
    const outcome = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        f.path(randomUUID()),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Yakitori-Attachment": "upload",
            "X-Attachment-Name": "stalled.png",
            "Transfer-Encoding": "chunked",
          },
        },
        (response) => {
          response.resume()
          reject(new Error(`Unexpected response ${response.statusCode}`))
        },
      )
      request.on("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? "unknown"),
      )
      request.write(png)
      // Keep the body open: only the server's deadline may terminate it.
    })
    expect(outcome).toBe("ECONNRESET")
    f.gate.close()
    await f.gate.shutdown()
    expect(await readdir(f.incoming)).toEqual([])
    expect(await readdir(join(f.root, "rollouts"))).toEqual([])
  })
  it("reports unexpected cleanup failures even after the client disconnects", async () => {
    const f = await fixture()
    const failure = Object.assign(new Error("cleanup failed"), { code: "EIO" })
    vi.spyOn(f.assets, "discardEphemeralRolloutFiles").mockRejectedValue(
      failure,
    )
    const schedule = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, delay, ...args) =>
        schedule(callback, delay === 120_000 ? 25 : delay, ...args),
    )
    await new Promise<void>((resolve) => {
      const request = httpRequest(f.path(randomUUID()), {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Yakitori-Attachment": "upload",
          "X-Attachment-Name": "stalled.png",
          "Transfer-Encoding": "chunked",
        },
      })
      request.on("error", () => resolve())
      request.write(png)
    })
    f.gate.close()
    await f.gate.shutdown()
    expect(f.failures).toEqual([
      expect.objectContaining({
        component: "http-server",
        operation: "handle-request",
        cause: failure,
      }),
    ])
    expect(await readdir(f.incoming)).toEqual([])
  })
})
