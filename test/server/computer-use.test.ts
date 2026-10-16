import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  connectComputerUse,
  disconnectComputerUse,
  readComputerUseStatus,
} from "../../src/server/computer-use.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function fixture(
  toolName = "control",
  permissions = { accessibility: true, screenRecording: true },
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-computer-"))
  directories.push(root)
  const helperPath = join(root, "computer.cjs")
  // A real executable exercises initialization, permission probing and disposal.
  await writeFile(
    helperPath,
    `#!${process.execPath}
    const readline = require("node:readline");
    readline.createInterface({input: process.stdin}).on("line", line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === "initialize"
        ? {protocolVersion: request.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "test-computer", version: "1"}}
        : request.method === "tools/call"
          ? {content: [], structuredContent: ${JSON.stringify(permissions)}}
          : {tools: [{name: ${JSON.stringify(toolName)}, inputSchema: {type:"object"}}, {name:"turn_ended",inputSchema:{type:"object"}}]};
      process.stdout.write(JSON.stringify({jsonrpc:"2.0", id:request.id, result}) + "\\n");
    });`,
    { mode: 0o755 },
  )
  const configPath = join(root, "config.toml")
  await writeFile(configPath, 'instructions = "preserve this"\n')
  return {
    options: { helperPath, platform: "darwin" },
    configPath,
    config: createUserConfigStore({ configPath }),
  }
}

describe("computer use connection", () => {
  it("discovers a real MCP process and persists native connect and disconnect across store reloads", async () => {
    const { config, configPath, options } = await fixture()
    expect(await readComputerUseStatus(config, options)).toMatchObject({
      available: true,
      connected: false,
    })
    const connected = await connectComputerUse(config, options)
    expect(connected).toMatchObject({
      available: true,
      connected: true,
      tools: ["control"],
    })
    expect(JSON.stringify(connected)).not.toContain("codex")
    const reloaded = createUserConfigStore({ configPath })
    const saved = await reloaded.readConfiguration()
    expect(saved.baseInstructions).toBe("preserve this")
    expect(saved.mcpServers?.computer).toMatchObject({
      enabled: true,
      enabledTools: ["control"],
      args: ["--mcp"],
    })
    expect(await readComputerUseStatus(reloaded, options)).toMatchObject({
      connected: true,
      tools: ["control"],
    })
    expect(await disconnectComputerUse(reloaded, options)).toMatchObject({
      connected: false,
    })
    expect(
      (await config.readConfiguration()).mcpServers?.computer?.enabled,
    ).toBe(false)
  })

  it("reports a connected helper with missing OS access without claiming it is ready", async () => {
    const { config, options } = await fixture("control", {
      accessibility: false,
      screenRecording: true,
    })
    expect(await connectComputerUse(config, options)).toMatchObject({
      connected: true,
      permissions: { accessibility: false, screenRecording: true },
      message: expect.stringContaining("System Settings"),
    })
  })

  it("does not persist a connection when the service lacks its desktop tool", async () => {
    const { config, configPath, options } = await fixture("unrelated")
    const before = await readFile(configPath, "utf8")
    await expect(connectComputerUse(config, options)).rejects.toThrow(
      "desktop tool",
    )
    expect(await readFile(configPath, "utf8")).toBe(before)
  })

  it("does not claim readiness when the configured desktop tool is disabled", async () => {
    const { config, options } = await fixture()
    await connectComputerUse(config, options)
    await config.writeValue({
      keyPath: ["mcp_servers", "computer", "disabled_tools"],
      value: ["control"],
    })
    expect(await readComputerUseStatus(config, options)).toMatchObject({
      connected: false,
      tools: [],
    })
  })

  it("reports unavailable without configuring a backend on unsupported hosts", async () => {
    const { config, configPath, options } = await fixture()
    const unsupported = { ...options, platform: "linux" }
    expect(await readComputerUseStatus(config, unsupported)).toMatchObject({
      available: false,
      connected: false,
      backend: null,
    })
    await expect(connectComputerUse(config, unsupported)).rejects.toThrow(
      "macOS before connecting",
    )
    expect(await readFile(configPath, "utf8")).toBe(
      'instructions = "preserve this"\n',
    )
  })
})
