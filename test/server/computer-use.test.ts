import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

async function fixture(toolName = "js") {
  const root = await mkdtemp(join(tmpdir(), "yakitori-computer-"))
  directories.push(root)
  const plugin = join(
    root,
    "plugins/cache/openai-bundled/unified-computer-use/1.0.0",
  )
  await mkdir(plugin, { recursive: true })
  // A real stdio process exercises initialization, discovery, and disposal.
  const source = `
    const readline = require("node:readline");
    readline.createInterface({input: process.stdin}).on("line", line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === "initialize"
        ? {protocolVersion: request.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "test-computer", version: "1"}}
        : {tools: [{name: ${JSON.stringify(toolName)}, inputSchema: {type:"object"}}, {name:"js_reset",inputSchema:{type:"object"}}, {name:"turn_ended",inputSchema:{type:"object"}}]};
      process.stdout.write(JSON.stringify({jsonrpc:"2.0", id:request.id, result}) + "\\n");
    });`
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        cua_repl: {
          command: process.execPath,
          args: ["-e", source],
          env: {
            TEST_PRIVATE_VALUE: "not-for-status",
            CUA_REPL_ENABLED_SURFACES: "browser,computer",
          },
          startup_timeout_sec: 2,
        },
      },
    }),
  )
  const configPath = join(root, "config.toml")
  await writeFile(configPath, 'instructions = "preserve this"\n')
  return {
    options: { codexHome: root, platform: "darwin" },
    configPath,
    config: createUserConfigStore({ configPath }),
  }
}

describe("computer use connection", () => {
  it("discovers a real MCP process and persists desktop-only connect and disconnect across store reloads", async () => {
    const { config, configPath, options } = await fixture()
    expect(await readComputerUseStatus(config, options)).toMatchObject({
      available: true,
      connected: false,
    })
    const connected = await connectComputerUse(config, options)
    expect(connected).toMatchObject({
      available: true,
      connected: true,
      tools: ["js", "js_reset"],
    })
    expect(JSON.stringify(connected)).not.toContain("not-for-status")
    const reloaded = createUserConfigStore({ configPath })
    const saved = await reloaded.readConfiguration()
    expect(saved.baseInstructions).toBe("preserve this")
    expect(saved.mcpServers?.cua_repl).toMatchObject({
      enabled: true,
      enabledTools: ["js", "js_reset"],
      env: { CUA_REPL_ENABLED_SURFACES: "computer" },
    })
    expect(await readComputerUseStatus(reloaded, options)).toMatchObject({
      connected: true,
      tools: ["js", "js_reset"],
    })
    expect(await disconnectComputerUse(reloaded, options)).toMatchObject({
      connected: false,
    })
    expect(
      (await config.readConfiguration()).mcpServers?.cua_repl?.enabled,
    ).toBe(false)
  })

  it("does not persist a connection when the service lacks its desktop tool", async () => {
    const { config, configPath, options } = await fixture("unrelated")
    const before = await readFile(configPath, "utf8")
    await expect(connectComputerUse(config, options)).rejects.toThrow(
      "desktop tool",
    )
    expect(await readFile(configPath, "utf8")).toBe(before)
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
      "before connecting",
    )
    expect(await readFile(configPath, "utf8")).toBe(
      'instructions = "preserve this"\n',
    )
  })
})
