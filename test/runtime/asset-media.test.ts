import { once } from "node:events"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import sharp from "sharp"
import {
  prepareProviderMedia,
  readAssetSource,
} from "../../src/runtime/asset-media.ts"
import type { ModelRequest } from "../../src/runtime/model.ts"

describe("request asset access", () => {
  it("reads external content and reports HTTP errors at the asset boundary", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/image" ? 200 : 404)
      response.end("external image bytes")
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Missing test server port")
    const base = `http://127.0.0.1:${address.port}`
    try {
      expect(
        await readAssetSource({ url: `${base}/image` }, undefined),
      ).toEqual(Buffer.from("external image bytes"))
      await expect(
        readAssetSource({ url: `${base}/missing` }, undefined),
      ).rejects.toThrow("HTTP 404")
      const controller = new AbortController()
      controller.abort()
      await expect(
        readAssetSource({ url: `${base}/image` }, undefined, controller.signal),
      ).rejects.toThrow()
      await expect(
        readAssetSource({ url: "file:///tmp/image.png" }, undefined),
      ).rejects.toThrow("HTTP(S)")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it("uses the configured asset address without reading or uploading the owned PDF", async () => {
    const source = {
      rolloutId: "rollout_one",
      path: "attachments/requests/request_one/report.pdf",
    }
    const input: ModelRequest = {
      target: {
        provider: "personal",
        model: "test",
        instructionProfileId: "default",
      },
      system: [],
      tools: [],
      toolWireProtocol: "eager",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              name: "report.pdf",
              mediaType: "application/pdf",
              sizeBytes: 10,
              file: source,
            },
          ],
        },
      ],
      assets: {
        async read() {
          throw new Error("Public URL should avoid inline reads")
        },
        url(file) {
          expect(file).toEqual(source)
          return "https://cdn.example/yakitori/report.pdf"
        },
      },
    }
    const media = await prepareProviderMedia(input, {
      async uploadDocument() {
        throw new Error("Public URL should avoid upload")
      },
    })
    expect(media.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "document",
            name: "report.pdf",
            mediaType: "application/pdf",
            sizeBytes: 10,
            file: { url: "https://cdn.example/yakitori/report.pdf" },
          },
        ],
      },
    ])
    expect(input.messages[0]?.content[0]).toMatchObject({ file: source })
  })
})

it.each([
  "inline",
  "file",
] as const)("rejects a later corrupt %s image before uploading any preceding PDF", async (source) => {
  const corrupt = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(corrupt)
  corrupt.writeUInt32BE(100, 16)
  corrupt.writeUInt32BE(100, 20)
  let uploads = 0
  const request: ModelRequest = {
    target: {
      provider: "test",
      model: "vision",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            name: "first.pdf",
            mediaType: "application/pdf",
            sizeBytes: 6,
            file: { rolloutId: "rollout_one", path: "first.pdf" },
          },
          {
            type: "image",
            mediaType: "image/png",
            detail: "original",
            ...(source === "inline"
              ? { data: corrupt.toString("base64") }
              : {
                  sizeBytes: corrupt.length,
                  file: { rolloutId: "rollout_one", path: "bad.png" },
                }),
          },
        ],
      },
    ],
    assets: {
      async read(file) {
        return "path" in file && file.path === "first.pdf"
          ? Buffer.from("%PDF-1")
          : corrupt
      },
    },
  }
  const original = JSON.stringify(request.messages)
  await expect(
    prepareProviderMedia(request, {
      async uploadDocument() {
        uploads += 1
        return "uploaded_pdf"
      },
    }),
  ).rejects.toThrow("Image was not sent: unable to decode image")
  expect(uploads).toBe(0)
  expect(JSON.stringify(request.messages)).toBe(original)
})

it("keeps external image URLs provider-owned rather than fetching them in preflight", async () => {
  const input: ModelRequest = {
    target: {
      provider: "test",
      model: "vision",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            sizeBytes: 0,
            file: { url: "https://example.invalid/image.png" },
          },
        ],
      },
    ],
    assets: {
      async read() {
        throw new Error("Unexpected URL fetch")
      },
    },
  }
  expect((await prepareProviderMedia(input)).messages).toEqual(input.messages)
})

it("keeps provider-addressable owned image URLs independent of local readability", async () => {
  const source = { rolloutId: "rollout_one", path: "image.png" }
  const input: ModelRequest = {
    target: {
      provider: "test",
      model: "vision",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", sizeBytes: 1, file: source },
        ],
      },
    ],
    assets: {
      async read() {
        throw new Error("Hosted asset should not require local bytes")
      },
      url() {
        return "https://example.invalid/hosted.png"
      },
    },
  }
  expect(
    (await prepareProviderMedia(input)).messages[0]?.content[0],
  ).toMatchObject({
    file: { url: "https://example.invalid/hosted.png" },
  })
  expect(input.messages[0]?.content[0]).toMatchObject({ file: source })
})

it.each([
  "inline",
  "file",
] as const)("uses the same resolution-preserving fallback and actual MIME for %s images", async (source) => {
  const bytes = await sharp({
    create: {
      width: 4096,
      height: 1024,
      channels: 4,
      background: { r: 90, g: 20, b: 40, alpha: 0.25 },
    },
  })
    .png()
    .toBuffer()
  const input: ModelRequest = {
    target: {
      provider: "custom",
      model: "vision",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/jpeg",
            detail: "high",
            ...(source === "inline"
              ? { data: bytes.toString("base64") }
              : {
                  file: { rolloutId: "rollout_one", path: "image.png" },
                  sizeBytes: bytes.length,
                }),
          },
        ],
      },
    ],
    assets: { read: async () => bytes },
  }
  const before = structuredClone(input.messages)
  const media = await prepareProviderMedia(input)
  expect(media.messages[0]?.content[0]).toEqual({
    type: "image",
    mediaType: "image/png",
    detail: "high",
    data: bytes.toString("base64"),
  })
  expect(input.messages).toEqual(before)
})

it("rejects excessive inline image history before decoding data or uploading documents", async () => {
  let uploads = 0
  const repeatedImage = {
    type: "image" as const,
    mediaType: "image/png" as const,
    data: "A".repeat(40 * 1024 * 1024 + 1),
  }
  const input: ModelRequest = {
    target: {
      provider: "custom",
      model: "vision",
      instructionProfileId: "default",
    },
    system: [],
    tools: [],
    toolWireProtocol: "eager",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            name: "report.pdf",
            mediaType: "application/pdf",
            sizeBytes: 6,
            file: { rolloutId: "rollout_one", path: "report.pdf" },
          },
          repeatedImage,
          repeatedImage,
        ],
      },
    ],
    assets: {
      read: async () => {
        throw new Error("Must not read before admission")
      },
    },
  }
  await expect(
    prepareProviderMedia(input, {
      uploadDocument: async () => {
        uploads += 1
        return "file_one"
      },
    }),
  ).rejects.toThrow("80 MiB local compatibility image-data budget")
  expect(uploads).toBe(0)
})
