import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { DesktopUpdateArchive } from "../../src/desktop/update-release.ts"
import { indexDesktopUpdateTar } from "../../src/desktop/update-tar-index.ts"
import { downloadDesktopUpdate } from "../../src/desktop/update-transfer.ts"

const exec = promisify(execFile)
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }),
  )
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(stableSize = 600_123, inlineMetadata = false) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-update-transfer-"))
  roots.push(root)
  const source = join(root, "source")
  const installedAppPath = join(root, "installed.app")
  const relative = `Contents/Resources/${"long-file-name-".repeat(10)}.bin`
  const stable = Buffer.alloc(stableSize, 97)
  const helper = Buffer.alloc(4097, 98)
  for (const app of [join(source, "Yakitori.app"), installedAppPath]) {
    await mkdir(join(app, "Contents/Resources"), { recursive: true })
    await writeFile(join(app, relative), stable)
    await writeFile(join(app, "Contents/Resources/helper"), helper)
  }
  // A locally re-signed helper keeps its name/size and must fail digest reuse.
  await writeFile(
    join(installedAppPath, "Contents/Resources/helper"),
    Buffer.alloc(helper.length, 99),
  )
  const archivePath = join(root, "archive.tar")
  await exec(
    "/usr/bin/tar",
    ["--format=pax", "-cf", archivePath, "-C", source, "Yakitori.app"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  )
  const bytes = await readFile(archivePath)
  const archive: DesktopUpdateArchive = {
    url: "",
    size: bytes.length,
    sha256: digest(bytes),
    chunks: await indexDesktopUpdateTar(archivePath),
  }
  // Preserve coverage for existing manifests whose metadata requires ranges.
  if (!inlineMetadata)
    for (const chunk of archive.chunks ?? []) delete chunk.data
  return {
    root,
    bytes,
    archive,
    stable,
    relative,
    installedAppPath,
    destination: join(root, "download.tar"),
    cacheDirectory: join(root, "cache"),
  }
}

async function http(
  bytes: Buffer,
  mode: "range" | "full" | "bad-range" | "corrupt" | "truncated" = "range",
) {
  const requests: string[] = []
  let sentBytes = 0
  const server = createServer((request, response) => {
    const range = request.headers.range
    requests.push(range ?? "full")
    if (!range || mode === "full") {
      response.writeHead(200, { "Content-Length": bytes.length })
      sentBytes += bytes.length
      response.end(bytes)
      return
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!match) throw new Error("Unexpected Range request.")
    const start = Number(match[1])
    const end = Number(match[2])
    const payload = Buffer.from(bytes.subarray(start, end + 1))
    if (mode === "corrupt") payload[0] = (payload[0] ?? 0) ^ 255
    response.writeHead(206, {
      "Content-Range": `bytes ${mode === "bad-range" ? start + 1 : start}-${end}/${bytes.length}`,
      ...(mode === "truncated" ? {} : { "Content-Length": payload.length }),
    })
    const sent =
      mode === "truncated" ? payload.subarray(0, payload.length - 1) : payload
    sentBytes += sent.length
    response.end(sent)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("HTTP server has no port.")
  return {
    url: `http://127.0.0.1:${address.port}/archive.tar`,
    requests,
    sentBytes: () => sentBytes,
  }
}

describe("verified incremental desktop archive transfer", () => {
  it("keeps unmappable regular file payloads out of inline metadata", async () => {
    const value = await fixture()
    const payload = Buffer.from("unmappable regular file payload")
    await writeFile(join(value.root, "unmapped.bin"), payload)
    const archivePath = join(value.root, "unmapped.tar")
    await exec(
      "/usr/bin/tar",
      ["-cf", archivePath, "-C", value.root, "unmapped.bin"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    )
    const bytes = await readFile(archivePath)
    const chunks = await indexDesktopUpdateTar(archivePath)
    expect(chunks).toContainEqual({
      offset: bytes.indexOf(payload),
      size: payload.length,
      sha256: digest(payload),
    })
    expect(
      chunks.filter((chunk) => chunk.data !== undefined).length,
    ).toBeGreaterThan(0)
  })

  it("reconstructs hundreds of file headers from authenticated manifest metadata without requesting their ranges", async () => {
    const value = await fixture(600_123, true)
    const source = join(value.root, "source", "Yakitori.app")
    for (let index = 0; index < 500; index++) {
      const relative = `Contents/Resources/file-${index}.txt`
      await Promise.all(
        [source, value.installedAppPath].map((app) =>
          writeFile(join(app, relative), `unchanged file ${index}\n`),
        ),
      )
    }
    const archivePath = join(value.root, "inline-metadata.tar")
    await exec(
      "/usr/bin/tar",
      [
        "--format=pax",
        "-cf",
        archivePath,
        "-C",
        join(value.root, "source"),
        "Yakitori.app",
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    )
    const bytes = await readFile(archivePath)
    const chunks = await indexDesktopUpdateTar(archivePath)
    const server = await http(bytes)
    const archive: DesktopUpdateArchive = JSON.parse(
      JSON.stringify({
        url: server.url,
        size: bytes.length,
        sha256: digest(bytes),
        chunks,
      }),
    )
    const metadata = chunks.filter((chunk) => chunk.data !== undefined)
    expect(metadata.length).toBeGreaterThan(500)
    const inlineBytes = metadata.reduce(
      (total, chunk) => total + Buffer.from(chunk.data ?? "", "base64").length,
      0,
    )
    const stats = await downloadDesktopUpdate({ ...value, archive })
    const changedHelperOffset = bytes.indexOf(Buffer.alloc(4097, 98))
    expect(changedHelperOffset).toBeGreaterThan(0)
    expect(server.requests).toEqual([
      `bytes=${changedHelperOffset}-${changedHelperOffset + 4096}`,
    ])
    expect(stats.downloadedBytes).toBe(server.sentBytes() + inlineBytes)
    expect(stats.downloadedBytes + stats.reusedBytes).toBe(bytes.length)
    expect((await readFile(value.destination)).equals(bytes)).toBe(true)
    const warmed = await downloadDesktopUpdate({ ...value, archive })
    expect(server.requests).toHaveLength(1)
    expect(warmed).toEqual({
      downloadedBytes: inlineBytes,
      reusedBytes: bytes.length - inlineBytes,
      totalBytes: bytes.length,
    })
  })

  it.each([
    "not base64",
    "YQ",
    "YR==",
    "YQ==\n",
    "Yg==",
  ])("rejects invalid or corrupt inline metadata %j before cache or HTTP access", async (data) => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-inline-chunk-"))
    roots.push(root)
    const server = await http(Buffer.from("a"))
    await expect(
      downloadDesktopUpdate({
        archive: {
          url: server.url,
          size: 1,
          sha256: digest(Buffer.from("a")),
          chunks: [
            { offset: 0, size: 1, sha256: digest(Buffer.from("a")), data },
          ],
        },
        destination: join(root, "archive.tar"),
        cacheDirectory: join(root, "cache"),
      }),
    ).rejects.toThrow(/Inline chunk/)
    expect(server.requests).toEqual([])
    await expect(readdir(join(root, "cache"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("splits large regular payloads into bounded chunks with correct installed source offsets", async () => {
    const value = await fixture(4 * 1024 * 1024 + 123)
    const payload = value.archive.chunks?.filter(
      (chunk) => chunk.sourcePath === value.relative,
    )
    expect(payload?.map((chunk) => [chunk.sourceOffset, chunk.size])).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 123],
    ])
    const server = await http(value.bytes)
    value.archive.url = server.url
    const stats = await downloadDesktopUpdate(value)
    expect(stats.reusedBytes).toBeGreaterThanOrEqual(value.stable.length)
    expect(stats.downloadedBytes).toBeLessThan(
      value.bytes.length - value.stable.length + 1,
    )
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
  })

  it("reuses real installed PAX file payloads, fetches changed bytes, and then transfers zero bytes from a warm cache", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    expect(
      value.archive.chunks?.some(
        (chunk) => chunk.sourcePath === value.relative,
      ),
    ).toBe(true)
    const stats = await downloadDesktopUpdate(value)
    expect(stats.totalBytes).toBe(value.bytes.length)
    expect(stats.reusedBytes).toBeGreaterThanOrEqual(value.stable.length)
    expect(stats.downloadedBytes).toBe(value.bytes.length - stats.reusedBytes)
    expect(stats.downloadedBytes).toBeLessThanOrEqual(
      value.bytes.length - value.stable.length,
    )
    expect(server.sentBytes()).toBe(stats.downloadedBytes)
    expect(server.sentBytes()).toBeLessThan(value.bytes.length)
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
    const requestCount = server.requests.length
    await rm(value.installedAppPath, { recursive: true })
    await rm(value.destination)
    const warmed = await downloadDesktopUpdate(value)
    expect(warmed).toEqual({
      downloadedBytes: 0,
      reusedBytes: value.bytes.length,
      totalBytes: value.bytes.length,
    })
    expect(server.requests).toHaveLength(requestCount)
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
  })

  it("discards corrupted cached bytes and downloads only their missing range", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    await downloadDesktopUpdate(value)
    await rm(value.installedAppPath, { recursive: true })
    const cache = join(value.cacheDirectory, "desktop-update-chunks-v1")
    const names = await readdir(cache)
    const name = names[0]
    if (!name) throw new Error("Expected populated cache.")
    const path = join(cache, name)
    const original = await readFile(path)
    await writeFile(path, Buffer.alloc(original.length, 255))
    const before = server.sentBytes()
    const stats = await downloadDesktopUpdate(value)
    expect(stats.downloadedBytes).toBe(original.length)
    expect(server.sentBytes() - before).toBe(original.length)
    expect(stats.reusedBytes).toBe(value.bytes.length - original.length)
    expect((await readFile(path)).equals(original)).toBe(true)
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
  })

  it("uses one verified full response when the server ignores Range and populates reusable cache", async () => {
    const value = await fixture()
    const server = await http(value.bytes, "full")
    value.archive.url = server.url
    const stats = await downloadDesktopUpdate(value)
    expect(stats).toEqual({
      downloadedBytes: value.bytes.length,
      reusedBytes: 0,
      totalBytes: value.bytes.length,
    })
    expect(server.requests).toHaveLength(1)
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
    const next = await downloadDesktopUpdate(value)
    expect(next.downloadedBytes).toBe(0)
    expect(server.requests).toHaveLength(1)
  })

  it("supports manifests without chunks using a verified full archive", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    delete value.archive.chunks
    value.archive.url = server.url
    expect((await downloadDesktopUpdate(value)).downloadedBytes).toBe(
      value.bytes.length,
    )
    expect(server.requests).toEqual(["full"])
    expect((await readFile(value.destination)).equals(value.bytes)).toBe(true)
  })

  it("rejects corrupted full fallback bytes before committing cache or destination", async () => {
    const value = await fixture()
    const corrupted = Buffer.from(value.bytes)
    corrupted[0] = (corrupted[0] ?? 0) ^ 255
    const server = await http(corrupted, "full")
    value.archive.url = server.url
    await expect(downloadDesktopUpdate(value)).rejects.toThrow(/SHA256/)
    expect(server.requests).toHaveLength(1)
    expect(
      await readdir(join(value.cacheDirectory, "desktop-update-chunks-v1")),
    ).toEqual([])
    await expect(readFile(value.destination)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it.each([
    "bad-range",
    "corrupt",
    "truncated",
  ] as const)("rejects %s network responses and preserves the existing destination", async (mode) => {
    const value = await fixture()
    const server = await http(value.bytes, mode)
    value.archive.url = server.url
    await writeFile(value.destination, "previous")
    await expect(downloadDesktopUpdate(value)).rejects.toThrow(
      mode === "bad-range"
        ? /range response/
        : mode === "corrupt"
          ? /SHA256/
          : /truncated/,
    )
    expect(await readFile(value.destination, "utf8")).toBe("previous")
    expect(
      await readdir(join(value.cacheDirectory, "desktop-update-chunks-v1")),
    ).toEqual([])
    expect(
      (await readdir(value.root)).some((name) => name.endsWith(".partial")),
    ).toBe(false)
  })

  it("rejects a full archive digest mismatch even when every chunk verifies", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    value.archive.sha256 = "f".repeat(64)
    await expect(downloadDesktopUpdate(value)).rejects.toThrow(
      /archive failed SHA256/,
    )
    await expect(readFile(value.destination)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("cancels an in-flight body without committing partial cache bytes or replacing destination", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    const controller = new AbortController()
    await writeFile(value.destination, "previous")
    await expect(
      downloadDesktopUpdate({
        ...value,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.downloadedBytes > 0) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(await readFile(value.destination, "utf8")).toBe("previous")
    expect(
      await readdir(join(value.cacheDirectory, "desktop-update-chunks-v1")),
    ).toEqual([])
    expect(
      (await readdir(value.root)).some((name) => name.endsWith(".partial")),
    ).toBe(false)
  })

  it("does not reuse files through an installed symlink pointing outside the app", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    const resources = join(value.installedAppPath, "Contents/Resources")
    const outside = join(value.root, "outside")
    await mkdir(outside)
    await writeFile(
      join(outside, value.relative.split("/").at(-1) ?? ""),
      value.stable,
    )
    await rm(resources, { recursive: true })
    await symlink(outside, resources)
    const stats = await downloadDesktopUpdate(value)
    const payloadOffset = value.bytes.indexOf(value.stable)
    expect(payloadOffset).toBeGreaterThan(0)
    expect(server.requests).toContain(
      `bytes=${payloadOffset}-${payloadOffset + value.stable.length - 1}`,
    )
    expect(stats.downloadedBytes).toBeGreaterThan(value.stable.length)
  })

  it("rejects traversal paths before any network request or cache mutation", async () => {
    const value = await fixture()
    const chunk = value.archive.chunks?.[0]
    if (!chunk) throw new Error("Expected chunk.")
    chunk.sourcePath = "../outside"
    chunk.sourceOffset = 0
    await expect(downloadDesktopUpdate(value)).rejects.toThrow(/source path/)
    await expect(readdir(value.cacheDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("prunes only owned cache files and refuses a symlink cache directory", async () => {
    const value = await fixture()
    const server = await http(value.bytes)
    value.archive.url = server.url
    const cache = join(value.cacheDirectory, "desktop-update-chunks-v1")
    await mkdir(cache, { recursive: true })
    const stale = `${"e".repeat(64)}-12.chunk`
    await writeFile(join(cache, stale), "stale")
    await writeFile(join(cache, "unrelated"), "keep")
    await mkdir(join(cache, `${"d".repeat(64)}-12.chunk`))
    await downloadDesktopUpdate(value)
    expect(await readFile(join(cache, "unrelated"), "utf8")).toBe("keep")
    expect(await readdir(cache)).not.toContain(stale)
    await rm(cache, { recursive: true })
    const outside = join(value.root, "outside-cache")
    await mkdir(outside)
    await writeFile(join(outside, stale), "keep")
    await symlink(outside, cache)
    await expect(downloadDesktopUpdate(value)).rejects.toThrow(/real directory/)
    expect(await readFile(join(outside, stale), "utf8")).toBe("keep")
  })
})
