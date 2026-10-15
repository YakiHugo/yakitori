import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createMcpExtension } from "../../src/runtime/mcp-extension.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"

it("keeps captured MCP tools usable through configuration withdrawal and unmounts before registry disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-extension-"))
  const script = join(root, "server.mjs")
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); if(m.id === undefined) return;
  const result = m.method === 'initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
    : m.method === 'tools/list' ? {tools:[{name:'echo',inputSchema:{type:'object'}}]}
    : {content:[{type:'text',text:m.params.arguments.text}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`,
  )
  const registry = createToolRegistry([])
  const extension = createMcpExtension({ registry })
  const snapshots: ReturnType<typeof registry.finalize>[] = []
  try {
    expect(
      await extension.prepare({
        demo: { command: process.execPath, args: [script], required: true },
      }),
    ).toEqual([{ name: "demo", available: true }])
    const active = registry.finalize({
      enabledTrustedTools: new Set(),
      customToolMode: "function",
      wireProtocol: "eager",
    })
    snapshots.push(active)
    expect(
      await active.approvalRequirement(
        "demo__echo",
        {},
        { workspaceRoot: root },
      ),
    ).toMatchObject({ kind: "approval", action: "command_execution" })
    await extension.prepare({})
    const next = registry.finalize({
      enabledTrustedTools: new Set(),
      customToolMode: "function",
      wireProtocol: "eager",
    })
    snapshots.push(next)
    expect(next.get("demo__echo")).toBeUndefined()
    expect(
      await active.execute(
        "demo__echo",
        { text: "captured connection" },
        { workspaceRoot: root },
      ),
    ).toMatchObject({ ok: true, content: "captured connection" })
    await active.release()
    await next.release()
    const closing = extension.close()
    expect(extension.close()).toBe(closing)
    await closing
    await registry.dispose()
    await expect(extension.prepare({})).rejects.toThrow("closed")
  } finally {
    await Promise.all(snapshots.map((snapshot) => snapshot.release()))
    await extension.close()
    await registry.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it("joins an already running turn-end cleanup before closing its MCP process", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-turn-close-"))
  const script = join(root, "server.mjs")
  const marker = join(root, "stopping")
  const release = join(root, "release")
  const pidFile = join(root, "pid")
  await writeFile(
    script,
    `
import {existsSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
createInterface({input:process.stdin}).on('line', async line => {
  const m=JSON.parse(line); if(m.id === undefined) return;
  let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
    : m.method==='tools/list'?{tools:['js','turn_ended'].map(name=>({name,inputSchema:{type:'object'}}))}
    : {content:[{type:'text',text:'done'}]};
  if(m.params?.name==='turn_ended') {
    writeFileSync(${JSON.stringify(marker)}, 'waiting');
    while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,5));
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`,
  )
  const registry = createToolRegistry([])
  const extension = createMcpExtension({
    registry,
    connection: {
      turnEndTools: { demo: { name: "turn_ended", input: () => ({}) } },
    },
  })
  let finish: Promise<void> | undefined
  try {
    await extension.update({
      demo: { command: process.execPath, args: [script], required: true },
    })
    await extension.manager.tools()[0]?.execute({}, { workspaceRoot: root })
    finish = extension.manager.finishTurn()
    await expect
      .poll(() => readFile(marker, "utf8").catch(() => ""))
      .toBe("waiting")
    const closing = extension.manager.close()
    expect(extension.manager.close()).toBe(closing)
    let settled = false
    const observed = closing.then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    const pid = Number(await readFile(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await writeFile(release, "release")
    await finish
    await observed
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await writeFile(release, "release")
    await finish
    await extension.close()
    await registry.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
