import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCanvas } from "@napi-rs/canvas"
import { afterEach, expect, it } from "vitest"
import { ComputerPreviewService } from "../../src/server/computer-preview.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"
import {
  createFakeHandlers,
  createTestProcessor,
  initializeConnection,
  openTestConnection,
} from "./rpc/testkit.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const target = {
  scope: "window",
  pid: 123456,
  launchTime: 1000,
  windowId: 101,
} as const

type Call = {
  helper: number
  action?: string
  args?: Record<string, unknown>
  exit?: boolean
  initializing?: boolean
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Preview process state did not settle.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false
    throw cause
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-preview-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const script = join(root, "computer.cjs"),
    log = join(root, "calls.jsonl"),
    block = join(root, "blocked"),
    wrong = join(root, "wrong")
  const initializing = join(root, "initializing")
  await writeFile(log, "")
  const canvas = createCanvas(2, 1)
  canvas.getContext("2d").fillRect(0, 0, 2, 1)
  const png = canvas.toBuffer("image/png").toString("base64")
  await writeFile(
    script,
    `#!${process.execPath}
const {appendFileSync, existsSync} = require('node:fs');
const readline = require('node:readline');
const log=${JSON.stringify(log)}, block=${JSON.stringify(block)}, wrong=${JSON.stringify(wrong)}, initializing=${JSON.stringify(initializing)};
const save=value=>appendFileSync(log,JSON.stringify({helper:process.pid,...value})+'\\n');
process.on('exit',()=>save({exit:true}));
process.on('SIGTERM',()=>process.exit(0));
const lines=readline.createInterface({input:process.stdin});
lines.on('close',()=>process.exit(0));
lines.on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.method==='initialize'){if(existsSync(initializing)){save({initializing:true});return;}return reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-preview-fixture',version:'1'}});}
 if(m.method==='tools/list')return reply({tools:[{name:'control',inputSchema:{type:'object'}}]});
 if(m.method!=='tools/call')throw new Error('Unexpected method');
 const args=m.params.arguments; save({action:args.action,args});
 if(args.action==='list')return reply({content:[],structuredContent:{apps:[{pid:123456,name:'Owned app'}],windows:[{pid:123456,window_id:101,launch_time:1000,title:'Owned window'}],displays:[{display_id:1,main:true}]}});
 if(args.action==='status')return reply({content:[],structuredContent:{pointer:{x:30,y:35}}});
 if(args.action!=='observe')throw new Error('Preview attempted an application mutation');
 if(existsSync(block))return;
 return reply({content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}],structuredContent:{image_width:2,image_height:1,frame:{x:10,y:20,width:100,height:50},windows:[{pid:123456,window_id:101,launch_time:existsSync(wrong)?1001:1000}]}});
});`,
    { mode: 0o755 },
  )
  const config = createUserConfigStore({
    configPath: join(root, "config.toml"),
  })
  await config.writeValue({
    keyPath: ["mcp_servers", "computer"],
    value: {
      command: script,
      args: ["--mcp"],
      enabled_tools: ["control"],
      enabled: true,
    },
  })
  const service = new ComputerPreviewService(
    config,
    (cause) => {
      throw cause
    },
    { helperPath: script, platform: "darwin" },
  )
  cleanups.push(() => service.close())
  const calls = async (): Promise<Call[]> =>
    (await readFile(log, "utf8"))
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Call)
  return { service, config, calls, block, wrong, initializing, png }
}

it("uses a persistent read-only connection and forwards the exact process incarnation", async () => {
  const { service, config, calls, png } = await fixture()
  const owner = { connectionId: 1, viewerId: "owned" }
  const catalog = await service.catalog(owner)
  expect(
    catalog.targets.find((entry) => entry.target.scope === "window"),
  ).toMatchObject({ label: "Owned app · Owned window", target })
  const frame = await service.capture(owner, target)
  expect(frame).toMatchObject({
    dataUrl: `data:image/png;base64,${png}`,
    width: 2,
    height: 1,
    frame: { x: 10, y: 20, width: 100, height: 50 },
    pointer: { x: 30, y: 35 },
  })
  const history = (await calls()).filter((call) => call.action)
  expect(new Set(history.map((call) => call.helper)).size).toBe(1)
  expect(history.map((call) => call.args)).toEqual([
    { action: "list" },
    {
      action: "observe",
      mode: "vision",
      scope: "window",
      pid: 123456,
      launch_time: 1000,
      window_id: 101,
    },
    { action: "status" },
  ])
  await config.writeValue({
    keyPath: ["mcp_servers", "computer", "enabled"],
    value: false,
  })
  await expect(service.capture(owner, target)).rejects.toThrow(
    "Connect computer",
  )
  const helper = history[0]?.helper
  expect(helper).toBeDefined()
  await until(async () => helper !== undefined && !alive(helper))
  expect((await calls()).filter((call) => call.action)).toHaveLength(3)
})

it("rejects a frame from a replacement process before returning its image", async () => {
  const { service, wrong } = await fixture()
  await writeFile(wrong, "wrong incarnation")
  await expect(
    service.capture({ connectionId: 1, viewerId: "owned" }, target),
  ).rejects.toThrow("process incarnation changed")
})

it("stopping during native initialization retires the starting process", async () => {
  const { service, calls, initializing } = await fixture()
  const owner = { connectionId: 1, viewerId: "startup" }
  await writeFile(initializing, "hold MCP handshake")
  const rejected = expect(service.catalog(owner)).rejects.toThrow(
    "preview stopped",
  )
  await until(async () => (await calls()).some((call) => call.initializing))
  const helper = (await calls()).find((call) => call.initializing)?.helper
  await service.stop(owner)
  await rejected
  expect(helper !== undefined && alive(helper)).toBe(false)
})

it("counts draining helpers against its resource bound before admitting another viewer", async () => {
  const { service, calls, block } = await fixture()
  await writeFile(block, "hold four captures")
  const pending = Array.from({ length: 4 }, (_, index) =>
    expect(
      service.capture(
        { connectionId: 1, viewerId: `bounded_${index}` },
        target,
      ),
    ).rejects.toThrow("preview stopped"),
  )
  await until(
    async () =>
      (await calls()).filter((call) => call.action === "observe").length === 4,
  )
  const extra = { connectionId: 1, viewerId: "extra" }
  await expect(service.catalog(extra)).rejects.toThrow("Too many live previews")
  const draining = service.stopAll()
  await expect(service.catalog(extra)).rejects.toThrow("Too many live previews")
  await draining
  await Promise.all(pending)
  await rm(block)
  await expect(service.capture(extra, target)).resolves.toMatchObject({
    width: 2,
  })
})

it("an old cancelled capture cannot retire a newly opened viewer with the same identity", async () => {
  const { service, calls, block } = await fixture()
  const owner = { connectionId: 1, viewerId: "restart" }
  await writeFile(block, "hold the old native reply")
  const rejected = expect(service.capture(owner, target)).rejects.toThrow(
    "preview stopped",
  )
  await until(async () =>
    (await calls()).some((call) => call.action === "observe"),
  )
  const stopping = service.stop(owner)
  const reopened = service.catalog(owner)
  await reopened
  await stopping
  await rejected
  await rm(block)
  await expect(service.capture(owner, target)).resolves.toMatchObject({
    width: 2,
    height: 1,
  })
  const history = await calls()
  const old = history.find((call) => call.action === "observe")?.helper
  const fresh = history.find((call) => call.action === "list")?.helper
  expect(old).not.toBe(fresh)
  expect(fresh !== undefined && alive(fresh)).toBe(true)
})

it("RPC validates read-only targets and drains a disconnected viewer without stopping another connection", async () => {
  const { service, config, calls, block } = await fixture()
  const { processor } = createTestProcessor({
    handlers: createFakeHandlers(),
    userConfig: config,
    computerPreview: service,
  })
  const first = openTestConnection(processor),
    second = openTestConnection(processor)
  await initializeConnection(first)
  await initializeConnection(second)
  const invalid = await first.sendRequest("computer/preview/capture", {
    viewerId: "same",
    target: { scope: "screen", displayId: 1, action: "key" },
  })
  expect(invalid).toMatchObject({ error: { code: -32602 } })
  expect(await calls()).toEqual([])
  await first.sendRequest("computer/preview/catalog", { viewerId: "same" })
  await second.sendRequest("computer/preview/catalog", { viewerId: "same" })
  const helpers = (await calls())
    .filter((call) => call.action === "list")
    .map((call) => call.helper)
  expect(helpers).toHaveLength(2)
  await writeFile(block, "hold capture until this RPC connection closes")
  const pending = first.sendRequest("computer/preview/capture", {
    viewerId: "same",
    target,
  })
  await until(async () =>
    (await calls()).some((call) => call.action === "observe"),
  )
  await expect(processor.closeConnection(first.id)).resolves.toBe("drained")
  expect(await pending).toMatchObject({
    error: { code: -32603, message: "Computer preview stopped." },
  })
  expect(helpers[0] !== undefined && alive(helpers[0])).toBe(false)
  expect(helpers[1] !== undefined && alive(helpers[1])).toBe(true)
  await rm(block)
  const remaining = await second.sendRequest("computer/preview/capture", {
    viewerId: "same",
    target,
  })
  expect(remaining).toMatchObject({ result: { width: 2, height: 1 } })
  await processor.closeConnection(second.id)
})
