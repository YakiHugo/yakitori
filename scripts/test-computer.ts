import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { McpClient } from "../src/runtime/mcp-client.ts"

const run = promisify(execFile)
const core = "native/computer/Sources/ComputerCore"
const executable = resolve("build/computer-contracts")
await run("swiftc", [
  "-parse-as-library",
  ...(await readdir(core))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => join(core, name)),
  "native/computer/Tests/Contracts.swift",
  "-o",
  executable,
])
const { stdout } = await run(executable)
process.stdout.write(stdout)

// Exercise the actual signed app through LaunchServices, stdio MCP, and a
// turn-end barrier. This never requests permissions or operates user apps.
const client = new McpClient(
  "computer",
  {
    command:
      process.env.YAKITORI_COMPUTER_EXECUTABLE ??
      resolve(
        "dist/native/Yakitori Computer.app/Contents/MacOS/yakitori-computer",
      ),
    args: ["--mcp"],
  },
  () => {},
  () => {},
  () => {},
)
let helperPid: number | undefined
try {
  const tools = await client.start()
  const control = tools.find((tool) => tool.name === "control")
  const cleanup = tools.find((tool) => tool.name === "turn_ended")
  if (!control || !cleanup) throw new Error("Native tools are missing.")
  const result = await client.bindTool(control)({ action: "status" })
  if (
    result.isError ||
    typeof result.structuredContent?.accessibility !== "boolean" ||
    typeof result.structuredContent.screenRecording !== "boolean"
  )
    throw new Error("Native permission status is invalid.")
  const pid = result.structuredContent.process_id
  if (typeof pid !== "number")
    throw new Error("The native helper did not identify its process.")
  helperPid = pid
  console.log("Native MCP app permission status:", result.structuredContent)
  const released = await client.bindTool(cleanup)({})
  if (released.isError) throw new Error("Native turn cleanup failed.")
} finally {
  await client.close()
}
console.log(
  "LaunchServices, MCP discovery, permission probing and turn cleanup passed.",
)

if (helperPid !== undefined) {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      process.kill(helperPid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        break
      throw error
    }
    if (Date.now() >= deadline)
      throw new Error(
        "The native app remained alive after its MCP connection closed.",
      )
    await new Promise((done) => setTimeout(done, 20))
  }
  console.log("Native app exits after its MCP connection closes.")
}
