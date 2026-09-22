import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../src/kernel/ids.ts"
import { createRolloutAssets } from "../../src/kernel/rollout-assets.ts"
import { prepareModelDocuments } from "../../src/runtime/prepare-model-document.ts"
import { mcpResult } from "../../src/runtime/tools/mcp-result.ts"
import { finalizeToolOutput } from "../../src/runtime/tools/result-output.ts"
import { pdfFixture } from "./tools/pdf-fixture.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function context() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-document-projection-"))
  roots.push(root)
  const rolloutId = createSessionId()
  await mkdir(join(root, "rollouts", rolloutId), { recursive: true })
  return {
    workspaceRoot: root,
    rolloutId,
    toolCallId: "mcp_pdf",
    rolloutAssets: createRolloutAssets(root, {
      withMutationLease: async (_id, mutate) => mutate(),
    }),
  }
}

describe("stored PDF model projection", () => {
  it("projects MCP PDFs natively, as page images, or as text without changing durable references", async () => {
    const ctx = await context()
    const pdf = pdfFixture(["MCP retained content"])
    const result = await mcpResult(
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: "mcp://document",
              mimeType: "application/pdf",
              blob: pdf.toString("base64"),
            },
          },
        ],
      },
      ctx,
    )
    const durable = await finalizeToolOutput(
      result,
      { maxBytes: 10_000, maxLines: 100 },
      ctx,
    )
    const original = JSON.stringify(durable)
    const documents = durable.documents ?? []
    expect(documents).toHaveLength(1)
    const native = await prepareModelDocuments(documents, ctx.rolloutAssets, {
      nativePdf: true,
      images: true,
    })
    expect(native.documents[0]?.data).toBe(pdf.toString("base64"))
    const vision = await prepareModelDocuments(documents, ctx.rolloutAssets, {
      nativePdf: false,
      images: true,
    })
    expect(vision.documents).toEqual([])
    expect(vision.images).toHaveLength(1)
    expect(vision.images[0]).toMatchObject({
      type: "image",
      mediaType: "image/jpeg",
      data: expect.any(String),
    })
    const text = await prepareModelDocuments(documents, ctx.rolloutAssets, {
      nativePdf: false,
      images: false,
    })
    expect(text.content).toContain("MCP retained content")
    expect(text.images).toEqual([])
    expect(text.documents).toEqual([])
    const nativeAgain = await prepareModelDocuments(
      documents,
      ctx.rolloutAssets,
      { nativePdf: true, images: true },
    )
    expect(nativeAgain.documents[0]?.file).toEqual(documents[0]?.file)
    expect(nativeAgain.documents[0]?.data).toBe(pdf.toString("base64"))
    expect(JSON.stringify(durable)).toBe(original)
  })

  it("makes page-limit failures actionable using the persisted PDF path", async () => {
    const ctx = await context()
    const bytes = pdfFixture(Array.from({ length: 11 }, () => "Large document"))
    const saved = await ctx.rolloutAssets.saveToolFile(
      ctx.rolloutId,
      ctx.toolCallId,
      "large.pdf",
      bytes,
    )
    const projection = await prepareModelDocuments(
      [
        {
          type: "document",
          mediaType: "application/pdf",
          name: "large.pdf",
          sizeBytes: bytes.length,
          file: saved.reference,
        },
      ],
      ctx.rolloutAssets,
      { nativePdf: false, images: false },
    )
    expect(projection.content).toContain("11 pages")
    expect(projection.content).toContain("was not read")
    expect(projection.content).toContain(saved.path)
    expect(projection.content).toContain('"pages":"1-5"')
    expect(projection.content).toContain('"format":"text"')
    expect(projection.documents).toEqual([])
  })

  it("reports invalid persisted PDFs instead of silently dropping them", async () => {
    const ctx = await context()
    const bytes = Buffer.from("%PDF-1.4\ninvalid")
    const saved = await ctx.rolloutAssets.saveToolFile(
      ctx.rolloutId,
      ctx.toolCallId,
      "broken.pdf",
      bytes,
    )
    const projection = await prepareModelDocuments(
      [
        {
          type: "document",
          mediaType: "application/pdf",
          name: "broken.pdf",
          sizeBytes: bytes.length,
          file: saved.reference,
        },
      ],
      ctx.rolloutAssets,
      { nativePdf: false, images: true },
    )
    expect(projection.content).toContain("Unable to read PDF")
    expect(projection.content).toContain(saved.path)
  })
})
