import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMcpConnectionManager } from "../../src/runtime/mcp-connection-manager.ts"

describe("MCP connection manager", () => {
  it("starts a stdio server, lists tools, calls them, and reuses unchanged identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-"))
    const script = join(root, "server.mjs")
    await writeFile(
      script,
      [
        "import readline from 'node:readline';",
        "const rl=readline.createInterface({input:process.stdin});",
        "rl.on('line',(line)=>{const m=JSON.parse(line); if(m.id===undefined)return;",
        "let result={}; if(m.method==='tools/list') result={tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};",
        "if(m.method==='tools/call') result={content:[{type:'text',text:m.params.arguments.text}]};",
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});",
      ].join("\n"),
    )
    const manager = createMcpConnectionManager()
    try {
      const config = { demo: { command: process.execPath, args: [script] } }
      await manager.update(config)
      const first = manager.tools()[0]
      expect(manager.status()).toEqual([
        { name: "demo", state: "ready", toolCount: 1 },
      ])
      expect(first?.toolName).toEqual({ namespace: "demo", name: "echo" })
      await expect(
        first?.execute({ text: "hello" }, { workspaceRoot: root }),
      ).resolves.toMatchObject({
        ok: true,
        content: "hello",
      })

      await manager.update(config)
      expect(manager.tools()[0]).toBe(first)
    } finally {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("restarts an exited server and republishes its tool catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-"))
    const script = join(root, "restart.mjs")
    await writeFile(
      script,
      [
        "import readline from 'node:readline';",
        "const rl=readline.createInterface({input:process.stdin});",
        "rl.on('line',(line)=>{const m=JSON.parse(line); if(m.id===undefined)return;",
        "let result={}; if(m.method==='tools/list') result={tools:[{name:'echo',inputSchema:{type:'object'}}]};",
        "if(m.method==='tools/call') result={content:[{type:'text',text:'before restart'}]};",
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n',()=>{if(m.method==='tools/call')process.exit(0)});});",
      ].join("\n"),
    )
    const manager = createMcpConnectionManager({ restartDelayMs: 0 })
    const catalogs: number[] = []
    const unsubscribe = manager.subscribe((_name, tools) => {
      catalogs.push(tools.length)
    })
    try {
      await manager.update({
        demo: { command: process.execPath, args: [script] },
      })
      const first = manager.tools()[0]
      await first?.execute({}, { workspaceRoot: root })

      await expect.poll(() => catalogs).toContain(0)
      await expect
        .poll(() => {
          const current = manager.tools()[0]
          return current !== undefined && current !== first
        })
        .toBe(true)
      expect(catalogs.at(-1)).toBe(1)
      expect(manager.status()).toEqual([
        { name: "demo", state: "ready", toolCount: 1 },
      ])
    } finally {
      unsubscribe()
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("cancels a queued restart when an explicit update reconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-"))
    const script = join(root, "generation.mjs")
    const starts = join(root, "starts.txt")
    const marker = join(root, "marker")
    await writeFile(
      script,
      [
        "import {appendFileSync,existsSync,writeFileSync} from 'node:fs';",
        `appendFileSync(${JSON.stringify(starts)},'start\\n');`,
        `const first=!existsSync(${JSON.stringify(marker)}); if(first)writeFileSync(${JSON.stringify(marker)},'');`,
        "import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});",
        "rl.on('line',(line)=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n',()=>{if(first&&m.method==='tools/list')process.exit(0)});});",
      ].join("\n"),
    )
    const manager = createMcpConnectionManager({ restartDelayMs: 200 })
    try {
      const config = { demo: { command: process.execPath, args: [script] } }
      await manager.update(config)
      await expect.poll(() => manager.status()[0]?.state).toBe("failed")
      await manager.update(config)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await expect(readFile(starts, "utf8")).resolves.toBe("start\nstart\n")
    } finally {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds automatic restart attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-"))
    const script = join(root, "always-exit.mjs")
    const starts = join(root, "starts.txt")
    await writeFile(
      script,
      [
        "import {appendFileSync} from 'node:fs';",
        `appendFileSync(${JSON.stringify(starts)},'start\\n');`,
        "import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});",
        "rl.on('line',(line)=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n',()=>{if(m.method==='tools/list')process.exit(0)});});",
      ].join("\n"),
    )
    const manager = createMcpConnectionManager({
      restartDelayMs: 1,
      maxRestartDelayMs: 2,
      maxRestartAttempts: 2,
    })
    try {
      await manager.update({
        demo: { command: process.execPath, args: [script] },
      })
      await expect
        .poll(
          async () =>
            (await readFile(starts, "utf8")).trim().split("\n").length,
        )
        .toBe(3)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(
        3,
      )
    } finally {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
