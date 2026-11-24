import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { McpClient } from "../src/runtime/mcp-client.ts"

const run = promisify(execFile)

export function bindComputerFixture(
  client: McpClient,
  tools: Awaited<ReturnType<McpClient["start"]>>,
): ReturnType<McpClient["bindTool"]> {
  const routes = new Map<string, ReturnType<McpClient["bindTool"]>>()
  for (const tool of tools) {
    const schema = tool.inputSchema.properties?.action as { enum?: string[] }
    assert(Array.isArray(schema?.enum), `Missing action list for ${tool.name}`)
    const call = client.bindTool(tool)
    for (const action of schema.enum) {
      assert(!routes.has(action), `Duplicate fixture action: ${action}`)
      routes.set(action, call)
    }
  }
  return (input, signal, context) => {
    const action = (input as { action: string }).action
    const call = routes.get(action)
    assert(call, `No native tool accepts fixture action: ${action}`)
    return call(input, signal, context)
  }
}

export async function prepareComputerFixture(
  source = resolve("native/computer/Tests/Fixture.swift"),
): Promise<string> {
  const [bytes, compiler, sdk] = await Promise.all([
    readFile(source),
    run("swiftc", ["--version"]),
    run("xcrun", ["--show-sdk-version"]),
  ])
  const identity = createHash("sha256")
    .update(bytes)
    .update(compiler.stdout)
    .update(sdk.stdout)
    .update(process.arch)
    .digest("hex")
  const executable = resolve("build/computer-fixtures", identity, "fixture")
  try {
    await access(executable)
    console.log("Reusing native fixture (source/compiler/SDK unchanged).")
    return executable
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  await mkdir(dirname(executable), { recursive: true })
  const pending = `${executable}.${randomUUID()}`
  try {
    await run("swiftc", [source, "-o", pending])
    await rename(pending, executable)
  } finally {
    await rm(pending, { force: true })
  }
  console.log("Compiled native fixture for changed source/compiler/SDK.")
  return executable
}
