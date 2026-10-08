import { once } from "node:events"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
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
