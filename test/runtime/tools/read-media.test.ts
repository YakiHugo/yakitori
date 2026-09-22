import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../../src/kernel/ids.ts"
import { createRolloutAssets } from "../../../src/kernel/rollout-assets.ts"
import { createReadDocumentTool } from "../../../src/runtime/tools/read-media.ts"
import { readPdf } from "../../../src/runtime/tools/read-pdf.ts"
import { finalizeToolOutput } from "../../../src/runtime/tools/result-output.ts"
import { pdfFixture } from "./pdf-fixture.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function context(texts = ["First page", "Second page", "Third page"]) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-pdf-"))
  roots.push(root)
  const rolloutId = createSessionId()
  await mkdir(join(root, "rollouts", rolloutId), { recursive: true })
  await writeFile(join(root, "document.pdf"), pdfFixture(texts))
  return {
    workspaceRoot: root,
    rolloutId,
    toolCallId: "read_pdf",
    rolloutAssets: createRolloutAssets(root, {
      withMutationLease: async (_id, mutate) => mutate(),
    }),
  }
}

const budget = { maxBytes: 10_000, maxLines: 100 }
describe("PDF document reading", () => {
  it("extracts selected text for a model without native PDF or images", async () => {
    const ctx = await context()
    const result = await createReadDocumentTool().execute(
      { path: "document.pdf", pages: "3, 2-3, 2" },
      ctx,
    )
    expect(result).toMatchObject({
      ok: true,
      output: { format: "text", pages: [2, 3], totalPages: 3 },
    })
    expect(result.content).toContain("--- Page 2 ---\nSecond page")
    expect(result.content).toContain("--- Page 3 ---\nThird page")
    expect(result.content).not.toContain("First page")
    const projected = await finalizeToolOutput(result, budget, ctx)
    expect(projected.documents).toBeUndefined()
    expect(projected.images).toBeUndefined()
  })

  it("renders selected pages as durable images for image-capable providers", async () => {
    const ctx = {
      ...(await context()),
      documentReading: { nativePdf: false, images: true },
    }
    const result = await createReadDocumentTool().execute(
      { path: "document.pdf", pages: "2-" },
      ctx,
    )
    expect(result).toMatchObject({
      ok: true,
      output: { format: "image", pages: [2, 3], totalPages: 3 },
    })
    const projected = await finalizeToolOutput(result, budget, ctx)
    await rm(join(ctx.workspaceRoot, "document.pdf"))
    expect(projected.images).toHaveLength(2)
    expect(projected.documents).toBeUndefined()
    const image = projected.images?.[0]
    if (image?.file === undefined) throw new Error("Missing page snapshot")
    const bytes = await ctx.rolloutAssets.read(image.file)
    expect(await sharp(bytes).metadata()).toMatchObject({
      format: "jpeg",
      width: 500,
      height: 333,
    })
    const stats = await sharp(bytes).stats()
    expect(stats.channels[0]?.min).toBeLessThan(100)
    expect(stats.channels[0]?.max).toBe(255)
  })

  it("uses native PDF only for whole-document reads and honors explicit formats", async () => {
    const ctx = {
      ...(await context()),
      documentReading: { nativePdf: true, images: true },
    }
    const tool = createReadDocumentTool()
    const native = await tool.execute({ path: "document.pdf" }, ctx)
    expect(
      (await finalizeToolOutput(native, budget, ctx)).documents,
    ).toHaveLength(1)
    const text = await tool.execute(
      { path: "document.pdf", format: "text" },
      ctx,
    )
    expect(text).toMatchObject({ ok: true, output: { format: "text" } })
    expect(text.content).toContain("First page")
    const selected = await tool.execute(
      { path: "document.pdf", pages: "1" },
      ctx,
    )
    expect(selected).toMatchObject({
      ok: true,
      output: { format: "image", pages: [1] },
    })
  })

  it("requires explicit pages for large extraction and enforces the page safety boundary", async () => {
    const ctx = await context(
      Array.from({ length: 21 }, (_item, index) => `Page ${index + 1}`),
    )
    const tool = createReadDocumentTool()
    const automatic = await tool.execute({ path: "document.pdf" }, ctx)
    expect(automatic).toMatchObject({ ok: false, code: "invalid_pdf_pages" })
    expect(automatic.content).toContain("21 pages")
    await expect(
      tool.execute({ path: "document.pdf", pages: "1-21" }, ctx),
    ).resolves.toMatchObject({ ok: false, code: "invalid_pdf_pages" })
    const selected = await tool.execute(
      { path: "document.pdf", pages: "21-" },
      ctx,
    )
    expect(selected).toMatchObject({ ok: true, output: { pages: [21] } })
    expect(selected.content).toContain("Page 21")
  })

  it.each([
    "0",
    "4",
    "2-1",
    "x",
    "",
    "1,,x",
    "99999999999999999999",
  ])("rejects invalid page selection %j", async (pages) => {
    const ctx = await context()
    await expect(
      createReadDocumentTool().execute({ path: "document.pdf", pages }, ctx),
    ).resolves.toMatchObject({ ok: false, code: "invalid_pdf_pages" })
  })

  it("reports malformed PDFs and missing files as tool failures", async () => {
    const ctx = await context()
    await writeFile(join(ctx.workspaceRoot, "broken.pdf"), "%PDF-1.4\ninvalid")
    const tool = createReadDocumentTool()
    await expect(
      tool.execute({ path: "broken.pdf" }, ctx),
    ).resolves.toMatchObject({ ok: false, code: "pdf_read_failed" })
    await expect(
      tool.execute({ path: "missing.pdf" }, ctx),
    ).resolves.toMatchObject({ ok: false, code: "path_not_found" })
  })

  it("rejects image extraction without image capability", async () => {
    const ctx = await context()
    await expect(
      createReadDocumentTool().execute(
        { path: "document.pdf", format: "image" },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: false, code: "unsupported_document_format" })
  })

  it("cancels PDF processing through the execution signal", async () => {
    const controller = new AbortController()
    const reading = readPdf(
      {
        bytes: Uint8Array.from(pdfFixture(["Cancel processing"])),
        format: "image",
      },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 10)
    await expect(reading).rejects.toMatchObject({ name: "AbortError" })
  })
})
