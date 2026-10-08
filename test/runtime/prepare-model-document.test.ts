import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRolloutAssets } from "../../src/core/rollout-assets.ts"
import { createSessionId } from "../../src/kernel/ids.ts"
import {
  createNativePdfBudget,
  prepareModelDocuments,
} from "../../src/runtime/prepare-model-document.ts"
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
    const documents =
      durable.content.filter((block) => block.type === "document") ?? []
    expect(documents).toHaveLength(1)
    const native = await prepareModelDocuments(documents, ctx.rolloutAssets, {
      nativePdf: true,
      images: true,
    })
    expect(native.documents).toEqual(documents)
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
    expect(nativeAgain.documents).toEqual(documents)
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

describe("native PDF request limits", () => {
  it("counts raw file bytes across OpenAI results and does not charge rejected reservations", () => {
    const budget = createNativePdfBudget({
      maxFileBytes: 50_000_000,
      fileLimitExclusive: true,
      maxRequestBytes: 50_000_000,
    })
    expect(budget.reserve(50_000_000, 1)).toContain("per-file")
    expect(budget.reserve(49_000_000, 1)).toBeUndefined()
    expect(budget.reserve(2_000_000, 1)).toContain("combined PDF request size")
    expect(budget.reserve(1_000_000, 1)).toBeUndefined()
    expect(budget.reserve(1, 1)).toContain("combined PDF request size")
  })

  it("counts each OpenAI file occurrence without inventing page or base64 limits", () => {
    const limits = {
      maxFileBytes: 50_000_000,
      fileLimitExclusive: true,
      maxRequestBytes: 50_000_000,
    }
    const boundary = createNativePdfBudget(limits)
    expect(boundary.reserve(25_000_000, 10_000)).toBeUndefined()
    expect(boundary.reserve(25_000_000, 10_000)).toBeUndefined()
    expect(boundary.reserve(1, 1)).toContain("combined PDF request size")
    const repeated = createNativePdfBudget(limits)
    expect(repeated.reserve(20_000_000, 1)).toBeUndefined()
    expect(repeated.reserve(20_000_000, 1)).toBeUndefined()
    expect(repeated.reserve(20_000_000, 1)).toContain(
      "combined PDF request size",
    )
  })

  it.each([
    100, 600,
  ])("reserves ordinary images before admitting PDFs into %i shared media units", (limit) => {
    const budget = createNativePdfBudget(
      { maxRequestMediaUnits: limit, maxInlineBytes: 8 },
      limit - 2,
    )
    expect(budget.reserve(3, 3)).toContain(
      `combined ${limit}-unit image/PDF-page`,
    )
    expect(budget.reserve(3, 1)).toBeUndefined()
    // A byte failure consumes no pages; a page failure consumes no bytes.
    expect(budget.reserve(4, 1)).toContain("inline PDF payload")
    expect(budget.reserve(3, 2)).toContain(
      `combined ${limit}-unit image/PDF-page`,
    )
    expect(budget.reserve(3, 1)).toBeUndefined()
    expect(budget.reserve(1, 1)).toContain(
      `combined ${limit}-unit image/PDF-page`,
    )
  })

  it("bounds aggregate Anthropic base64 only as a lower-bound preflight without a raw file quota", () => {
    const limits = { maxInlineBytes: 32_000_000 }
    const budget = createNativePdfBudget(limits)
    expect(budget.reserve(12_000_000, 1)).toBeUndefined()
    expect(budget.reserve(12_000_001, 1)).toContain("inline PDF payload")
    expect(budget.reserve(12_000_000, 1)).toBeUndefined()
    expect(budget.reserve(1, 1)).toContain("inline PDF payload")
    expect(createNativePdfBudget(limits).reserve(24_000_000, 1)).toBeUndefined()
    expect(createNativePdfBudget(limits).reserve(24_000_001, 1)).toContain(
      "inline PDF payload",
    )
  })

  it("labels conservative unknown-model admission separately from verified quotas", () => {
    const budget = createNativePdfBudget(
      { maxRequestMediaUnits: 100, mediaLimitIsConservative: true },
      99,
    )
    expect(budget.reserve(1, 2)).toContain("Yakitori's conservative 100-unit")
    expect(budget.reserve(1, 2)).toContain("unverified model")
    expect(budget.reserve(1, 1)).toBeUndefined()
  })

  it("counts Gemini page occurrences and base64 padding across the request", () => {
    const pages = createNativePdfBudget({
      maxFileBytes: 50_000_000,
      maxRequestPages: 1_000,
    })
    expect(pages.reserve(1, 1_001)).toContain("page limit")
    expect(pages.reserve(50_000_000, 500)).toBeUndefined()
    expect(pages.reserve(1, 500)).toBeUndefined()
    expect(pages.reserve(1, 1)).toContain("page limit")
    const inline = createNativePdfBudget({
      maxFileBytes: 50_000_000,
      maxInlineBytes: 12,
    })
    expect(inline.reserve(1, 1)).toBeUndefined()
    expect(inline.reserve(6, 1)).toBeUndefined()
    expect(inline.reserve(1, 1)).toContain("inline PDF payload")
  })

  it("shares page limits across separate history projections, retaining originals for retry or fallback", async () => {
    const ctx = await context()
    const pdf = pdfFixture(Array.from({ length: 500 }, () => "Native page"))
    const saved = await ctx.rolloutAssets.saveToolFile(
      ctx.rolloutId,
      "large_pdf",
      "report.pdf",
      pdf,
    )
    const document = {
      type: "document" as const,
      mediaType: "application/pdf" as const,
      name: "report.pdf",
      file: saved.reference,
      sizeBytes: pdf.length,
    }
    const original = JSON.stringify(document)
    const capabilities = {
      nativePdf: true,
      images: true,
      nativePdfLimits: {
        maxFileBytes: 50_000_000,
        maxRequestPages: 1_000,
        maxInlineBytes: 100_000_000,
      },
    }
    const budget = createNativePdfBudget(capabilities.nativePdfLimits)
    for (let index = 0; index < 2; index++) {
      const result = await prepareModelDocuments(
        [document],
        ctx.rolloutAssets,
        capabilities,
        undefined,
        budget,
      )
      expect(result.documents).toEqual([document])
    }
    const rejected = await prepareModelDocuments(
      [document],
      ctx.rolloutAssets,
      capabilities,
      undefined,
      budget,
    )
    expect(rejected.documents).toEqual([])
    expect(rejected.content).toContain("combined PDF request page limit")
    expect(rejected.content).toContain('"pages":"1-5"')
    const retried = await prepareModelDocuments(
      [document],
      ctx.rolloutAssets,
      capabilities,
    )
    expect(retried.documents).toEqual([document])
    expect(JSON.stringify(document)).toBe(original)
    expect(await ctx.rolloutAssets.read(saved.reference)).toEqual(pdf)
  })

  it("does not send malformed PDF bytes under a native capability", async () => {
    const ctx = await context()
    const bytes = Buffer.from("This is not a PDF")
    const saved = await ctx.rolloutAssets.saveToolFile(
      ctx.rolloutId,
      "bad_pdf",
      "invalid.pdf",
      bytes,
    )
    const result = await prepareModelDocuments(
      [
        {
          type: "document",
          mediaType: "application/pdf",
          name: "invalid.pdf",
          file: saved.reference,
          sizeBytes: bytes.length,
        },
      ],
      ctx.rolloutAssets,
      {
        nativePdf: true,
        images: true,
        nativePdfLimits: { maxFileBytes: 50_000_000 },
      },
    )
    expect(result.documents).toEqual([])
    expect(result.content).toContain("was not sent natively")
    expect(result.content).toContain("Original PDF retained")
    expect(await ctx.rolloutAssets.read(saved.reference)).toEqual(bytes)
  })
})
