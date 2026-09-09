import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionId } from "../../../src/kernel/ids.ts"
import {
  isModelMessage,
  type ModelToolResultMessage,
} from "../../../src/kernel/events.ts"
import { createRolloutAssets } from "../../../src/kernel/rollout-assets.ts"
import { toOpenAIInput } from "../../../src/runtime/openai-provider.ts"
import { toAnthropicMessages } from "../../../src/runtime/anthropic-provider.ts"
import { mcpResult } from "../../../src/runtime/tools/mcp-result.ts"
import {
  createViewImageTool,
  createReadDocumentTool,
} from "../../../src/runtime/tools/read-media.ts"
import { finalizeToolOutput } from "../../../src/runtime/tools/result-output.ts"
import { createUnifiedExecTools } from "../../../src/runtime/tools/unified-exec.ts"
import { createReadFileTool } from "../../../src/runtime/tools/read-file.ts"
import { createWebFetchTool } from "../../../src/runtime/tools/web-fetch.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function context() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-output-"))
  roots.push(root)
  const rolloutId = createSessionId()
  await mkdir(join(root, "rollouts", rolloutId), { recursive: true })
  return {
    workspaceRoot: root,
    rolloutId,
    toolCallId: "call_output",
    rolloutAssets: createRolloutAssets(root, {
      withMutationLease: async (_id, mutate) => mutate(),
    }),
  }
}
const budget = { maxBytes: 1024, maxLines: 20 }
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==",
  "base64",
)

describe("tool result persistence and model projection", () => {
  it("projects structured MCP results with text and keeps metadata host-only", async () => {
    const ctx = await context()
    const result = await mcpResult(
      {
        content: [{ type: "text", text: "Found one item" }],
        structuredContent: { items: ["item-1"] },
        _meta: { privateState: "host-only" },
      },
      ctx,
    )
    expect(result.output).toMatchObject({
      _meta: { privateState: "host-only" },
    })
    const projected = await finalizeToolOutput(result, budget, ctx)
    expect(projected.content).toBe('Found one item\n{"items":["item-1"]}')
    expect(JSON.stringify(projected)).not.toContain("host-only")
    const empty = await mcpResult(
      { content: [], _meta: { privateState: "host-only" } },
      ctx,
    )
    expect(empty.content).toBe("")
  })

  it("retains full text for a second read while bounding the model preview", async () => {
    const ctx = await context()
    const full = Array.from({ length: 150 }, (_, index) => `row ${index}`).join(
      "\n",
    )
    const result = await finalizeToolOutput(
      { ok: true, output: {}, content: full },
      budget,
      ctx,
    )
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024)
    const path = result.content.match(/saved to (.+?)\. Use/)?.[1]
    if (path === undefined) throw new Error("Missing recovery path")
    expect(await readFile(path, "utf8")).toBe(full)
    const later = await createReadFileTool().execute(
      { path: path, offset: 140, limit: 10 },
      ctx,
    )
    expect(later.content).toContain("row 148")
  })

  it("protects command status and retains the omitted middle in the log", async () => {
    const ctx = await context()
    const [exec, stdin] = createUnifiedExecTools()
    if (exec === undefined || stdin === undefined)
      throw new Error("Missing exec tools")
    try {
      const result = await exec.execute(
        {
          cmd: `node -e 'process.stdout.write("HEAD\\n" + "x".repeat(70000) + "\\nMIDDLE\\n" + "y".repeat(70000) + "\\nTAIL");setTimeout(()=>{},1000)'`,
          "yield-time_ms": 250,
        },
        ctx,
      )
      expect(result.ok).toBe(true)
      const output = result.output as {
        session_id: number
        output_file: string
      }
      const projected = await finalizeToolOutput(result, budget, ctx)
      expect(projected.content).toContain(`session ID ${output.session_id}`)
      expect(projected.content).toContain(output.output_file)
      expect(projected.content).toContain("TAIL")
      expect(Buffer.byteLength(projected.content)).toBeLessThanOrEqual(1024)
      expect(await readFile(output.output_file, "utf8")).toContain("MIDDLE")
      const finished = await stdin.execute(
        { session_id: output.session_id },
        ctx,
      )
      expect(finished.output).toMatchObject({
        exit_code: 0,
        output_file: output.output_file,
      })
    } finally {
      await exec.dispose?.()
    }
  })

  it("snapshots image bytes independently of the original file and serializes native media", async () => {
    const ctx = await context()
    const path = join(ctx.workspaceRoot, "screen.png")
    await writeFile(path, png)
    const result = await createViewImageTool().execute({ path }, ctx)
    const { toolContentTruncated, ...projected } = await finalizeToolOutput(
      result,
      budget,
      ctx,
    )
    expect(toolContentTruncated).toBe(false)
    const stored: ModelToolResultMessage = {
      role: "tool",
      toolCallId: "call_output",
      ...projected,
    }
    expect(isModelMessage(JSON.parse(JSON.stringify(stored)))).toBe(true)
    await rm(path)
    const image = stored.images?.[0]
    if (image === undefined) throw new Error("Missing image")
    if (image.file === undefined) throw new Error("Missing image snapshot")
    const recovered = await ctx.rolloutAssets.read(image.file)
    expect(recovered).toEqual(png)
    const request: ModelToolResultMessage = {
      ...stored,
      images: [
        {
          type: "image",
          mediaType: image.mediaType,
          data: recovered.toString("base64"),
        },
      ],
    }
    expect(toOpenAIInput([request])).toMatchObject([
      {
        type: "function_call_output",
        output: [
          { type: "input_text" },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${png.toString("base64")}`,
          },
        ],
      },
    ])
    expect(JSON.stringify(toAnthropicMessages([request]))).toContain(
      '"type":"image"',
    )
    expect(JSON.stringify(result.output)).not.toContain(png.toString("base64"))
  })

  it("preserves mixed MCP media when long text is offloaded", async () => {
    const ctx = await context()
    const result = await mcpResult(
      {
        content: [
          { type: "text", text: "long text\n".repeat(1000) },
          {
            type: "image",
            mimeType: "image/png",
            data: png.toString("base64"),
          },
        ],
      },
      ctx,
    )
    const projected = await finalizeToolOutput(result, budget, ctx)
    expect(projected.images).toHaveLength(1)
    expect(projected.content).toContain("Full text saved")
    expect(JSON.stringify(result.output)).not.toContain(png.toString("base64"))
    expect(Buffer.byteLength(projected.content)).toBeLessThanOrEqual(1024)
  })

  it("keeps PDF snapshots and uses provider-native document inputs", async () => {
    const ctx = await context()
    const path = join(ctx.workspaceRoot, "document.pdf")
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF")
    await writeFile(path, pdf)
    const result = await createReadDocumentTool().execute({ path }, ctx)
    const projected = await finalizeToolOutput(result, budget, ctx)
    const document = projected.documents?.[0]
    if (document === undefined) throw new Error("Missing document")
    await rm(path)
    const bytes = await ctx.rolloutAssets.read(document.file)
    expect(bytes).toEqual(pdf)
    const message: ModelToolResultMessage = {
      role: "tool",
      toolCallId: "call_output",
      ...projected,
      documents: [{ ...document, data: bytes.toString("base64") }],
    }
    expect(toOpenAIInput([message])).toMatchObject([
      {
        output: [
          { type: "input_text" },
          { type: "input_file", filename: "document.pdf" },
        ],
      },
    ])
    expect(JSON.stringify(toAnthropicMessages([message]))).toContain(
      '"type":"document"',
    )
    expect(JSON.stringify(toOpenAIInput([message], false, "grok"))).toContain(
      "was not sent",
    )
    expect(
      JSON.stringify(toOpenAIInput([message], false, "grok")),
    ).not.toContain(bytes.toString("base64"))
  })

  it("saves the entire fetched page before applying its own preview cap", async () => {
    const ctx = await context()
    const page = `front\n${"body\n".repeat(3000)}UNIQUE_PAGE_END`
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain")
      response.end(page)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === "string")
        throw new Error("Missing server address")
      const result = await createWebFetchTool({
        maxTextCharacters: 500,
      }).execute({ url: `http://127.0.0.1:${address.port}` }, ctx)
      const projected = await finalizeToolOutput(result, budget, ctx)
      const path = projected.content.match(/saved to (.+?)\. Use/)?.[1]
      if (path === undefined) throw new Error("Missing recovery path")
      expect(await readFile(path, "utf8")).toContain("UNIQUE_PAGE_END")
      expect(projected.content).not.toContain("UNIQUE_PAGE_END")
      expect(Buffer.byteLength(projected.content)).toBeLessThanOrEqual(1024)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it("does not recursively offload a paginated file read", async () => {
    const ctx = await context()
    await writeFile(
      join(ctx.workspaceRoot, "large.txt"),
      "a line\n".repeat(100),
    )
    const result = await createReadFileTool().execute(
      { path: "large.txt" },
      ctx,
    )
    const projected = await finalizeToolOutput(
      result,
      { maxBytes: 512, maxLines: 1 },
      ctx,
    )
    expect(projected.content).toContain("Read preview truncated")
    expect(projected.content).not.toContain("saved to")
  })
})
