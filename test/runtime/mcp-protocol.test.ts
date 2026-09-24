import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { expect, it } from "vitest"
import { createMcpConnectionManager } from "../../src/runtime/mcp-connection-manager.ts"
import { createToolRegistry } from "../../src/runtime/tools/registry.ts"
import { canonicalToolName } from "../../src/runtime/tools/tool-name.ts"

async function withServer(
  body: string,
  run: (fixture: {
    root: string
    manager: ReturnType<typeof createMcpConnectionManager>
    config: {
      demo: { command: string; args: string[]; required: boolean }
    }
  }) => Promise<void>,
  options: Parameters<typeof createMcpConnectionManager>[0] = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-mcp-protocol-"))
  const script = join(root, "server.mjs")
  await writeFile(
    script,
    `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
createInterface({input:process.stdin}).on('line',async line=>{
const m=JSON.parse(line);
if(m.method==='initialize') {send({id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}}});return;}
if(m.method==='notifications/initialized')return;
const reply = result => send({id:m.id,result});
${body}
});`,
  )
  const manager = createMcpConnectionManager({
    maxRestartAttempts: 0,
    ...options,
  })
  try {
    await run({
      root,
      manager,
      config: {
        demo: {
          command: process.execPath,
          args: [script, join(root, "effects")],
          // Tests assert on the connected catalog right after update();
          // required keeps that deterministic now that optional servers
          // connect in the background.
          required: true,
        },
      },
    })
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
}

it("collects every catalog page and routes normalized names to the original tool", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply(m.params?.cursor?{tools:[{name:'search_files',inputSchema:{type:'object'}}]}:{tools:[{name:'search.files',inputSchema:{type:'object'}}],nextCursor:'second'});
if(m.method==='tools/call')reply({content:[{type:'text',text:m.params.name}]});`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      expect(manager.tools()).toHaveLength(2)
      const names = manager
        .tools()
        .map((tool) => canonicalToolName(tool.toolName))
      expect(new Set(names).size).toBe(2)
      expect(
        names.every(
          (name) => /^[A-Za-z0-9_-]+$/.test(name) && name.length <= 64,
        ),
      ).toBe(true)
      expect(
        await manager.tools()[0]?.execute({}, { workspaceRoot: root }),
      ).toMatchObject({ content: "search.files" })
    },
  )
})

it("rejects cyclic pagination instead of publishing a partial catalog", async () => {
  await withServer(
    `if(m.method==='tools/list')reply({tools:[],nextCursor:'again'});`,
    async ({ manager, config }) => {
      await manager.update({ demo: { ...config.demo, required: false } })
      await manager.settleConnecting(5_000)
      expect(manager.tools()).toEqual([])
      expect(manager.status()).toMatchObject([
        { name: "demo", state: "failed" },
      ])
    },
  )
})

it("does not confuse a server request with a response having the same id", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'echo',inputSchema:{type:'object'}}]});
if(m.method==='tools/call'){send({id:m.id,method:'ping'});reply({content:[{type:'text',text:'actual result'}]});}`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      expect(
        await manager.tools()[0]?.execute({}, { workspaceRoot: root }),
      ).toMatchObject({ content: "actual result" })
    },
  )
})

it("does not send an already cancelled invocation to the server", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'write',inputSchema:{type:'object'}}]});
if(m.method==='tools/call'){appendFileSync(process.argv[2],'effect');reply({content:[]});}`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      await expect(
        manager
          .tools()[0]
          ?.execute({}, { workspaceRoot: root, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: "AbortError" })
      await expect(readFile(join(root, "effects"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    },
  )
})

it("accepts only empty native app access forms during an authorized computer call", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'js',inputSchema:{type:'object'}},{name:'js_reset',inputSchema:{type:'object'}}]});
if(m.method==='tools/call'){
  globalThis.callId=m.id;
  const sensitive=m.params.arguments.sensitive;
  send({id:'app-access',method:'elicitation/create',params:{
    mode:'form',message:'Allow app access?',
    _meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_params:{app:'com.example.App'}},
    requestedSchema:{type:'object',properties:sensitive?{password:{type:'string'}}:{},required:sensitive?['password']:[]}
  }});
}
if(m.id==='app-access'&&m.result)send({id:globalThis.callId,result:{content:[{type:'text',text:JSON.stringify(m.result)}]}});`,
    async ({ root, manager, config }) => {
      await manager.update({ cua_repl: config.demo })
      const js = manager.tools().find((tool) => tool.toolName.name === "js")
      const reset = manager
        .tools()
        .find((tool) => tool.toolName.name === "js_reset")
      if (js === undefined || reset === undefined) {
        throw new Error("The computer tools were not discovered.")
      }
      const accepted = await js.execute({}, { workspaceRoot: root })
      expect(JSON.parse(accepted.content)).toMatchObject({
        action: "accept",
        _meta: { persist: "session" },
      })
      const sensitive = await js.execute(
        { sensitive: true },
        { workspaceRoot: root },
      )
      expect(JSON.parse(sensitive.content)).toMatchObject({ action: "decline" })
      const outsideAction = await reset.execute({}, { workspaceRoot: root })
      expect(JSON.parse(outsideAction.content)).toMatchObject({
        action: "decline",
      })
    },
  )
})

it("propagates a tool deadline as cancellation without replaying the side effect", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'write',inputSchema:{type:'object'}}]});
if(m.method==='tools/call')appendFileSync(process.argv[2],'call\\n');
if(m.method==='notifications/cancelled')appendFileSync(process.argv[2],'cancel\\n');`,
    async ({ root, manager, config }) => {
      await manager.update({ demo: { ...config.demo, toolTimeoutMs: 30 } })
      await expect(
        manager.tools()[0]?.execute({}, { workspaceRoot: root }),
      ).rejects.toThrow()
      await expect
        .poll(() => readFile(join(root, "effects"), "utf8"))
        .toBe("call\ncancel\n")
    },
  )
})

it("routes general elicitation through the user boundary with invocation context", async () => {
  const requests: string[] = []
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'configure',inputSchema:{type:'object'}}]});
if(m.method==='tools/call'){
  globalThis.callId=m.id;
  send({id:'input',method:'elicitation/create',params:{
    mode:'form',message:'Choose label',
    requestedSchema:{type:'object',properties:{label:{type:'string'}},required:['label']}
  }});
}
if(m.id==='input'&&m.result)send({id:globalThis.callId,result:{content:[{type:'text',text:JSON.stringify(m.result)}]}});`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      const result = await manager.tools()[0]?.execute(
        {},
        {
          workspaceRoot: root,
          rolloutId: "session_test",
          turnId: "turn_test",
          toolCallId: "call_test",
        },
      )
      expect(JSON.parse(result?.content ?? "")).toEqual({
        action: "accept",
        content: { label: "chosen" },
      })
      expect(requests).toEqual(["demo:call_test:Choose label"])
    },
    {
      onElicitation: async (request, signal) => {
        signal.throwIfAborted()
        requests.push(
          `${request.serverName}:${request.context?.toolCallId}:${request.params.message}`,
        )
        return { action: "accept", content: { label: "chosen" } }
      },
    },
  )
})

it("does not retain a dead catalog when installation fails", async () => {
  await withServer(
    `if(m.method==='tools/list')reply({tools:[{name:'echo',inputSchema:{type:'object'}}]});`,
    async ({ manager, config }) => {
      await expect(manager.update(config)).rejects.toThrow(
        "installation failed",
      )
      expect(manager.tools()).toEqual([])
      expect(manager.status()).toEqual([])
    },
    {
      installTools: () => {
        throw new Error("installation failed")
      },
    },
  )
})

it("cancels a pending elicitation when its tool invocation times out", async () => {
  let cancelled = false
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'configure',inputSchema:{type:'object'}}]});
if(m.method==='tools/call')send({id:'input',method:'elicitation/create',params:{
  mode:'url',message:'Complete authorization',url:'https://example.com/authorize',elicitationId:'login'
}});`,
    async ({ root, manager, config }) => {
      await manager.update({ demo: { ...config.demo, toolTimeoutMs: 100 } })
      await expect(
        manager.tools()[0]?.execute(
          {},
          {
            workspaceRoot: root,
            rolloutId: "session_test",
            toolCallId: "call_test",
          },
        ),
      ).rejects.toThrow()
      await expect.poll(() => cancelled).toBe(true)
    },
    {
      onElicitation: async (request, signal) => {
        expect(request.params.mode).toBe("url")
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          ),
        )
        return { action: "cancel" }
      },
    },
  )
})

it("connects to Streamable HTTP with configured headers and executes tools", async () => {
  const sdk = new Server(
    { name: "http-fixture", version: "1" },
    { capabilities: { tools: {} } },
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  }))
  sdk.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      { type: "text", text: String(request.params.arguments?.message) },
    ],
  }))
  await sdk.connect(transport as Transport)
  const headers: (string | undefined)[] = []
  const http = createServer((request, response) => {
    headers.push(request.headers.authorization)
    void transport.handleRequest(request, response)
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing test listener")
  const manager = createMcpConnectionManager({ maxRestartAttempts: 0 })
  try {
    await manager.update({
      remote: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        httpHeaders: { Authorization: "Bearer test-token" },
        required: true,
      },
    })
    expect(manager.status()).toMatchObject([{ state: "ready" }])
    expect(
      await manager
        .tools()[0]
        ?.execute({ message: "hello" }, { workspaceRoot: tmpdir() }),
    ).toMatchObject({ content: "hello" })
    expect(headers.length).toBeGreaterThan(0)
    expect(headers.every((header) => header === "Bearer test-token")).toBe(true)
  } finally {
    await manager.close()
    await sdk.close()
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it("keeps a captured Step bound to its original connection during replacement", async () => {
  const registry = createToolRegistry([])
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'echo',inputSchema:{type:'object'}}]});
if(m.method==='tools/call')reply({content:[{type:'text',text:process.env.MCP_TEST_VALUE}]});`,
    async ({ root, manager, config }) => {
      await manager.update({
        demo: { ...config.demo, env: { MCP_TEST_VALUE: "original" } },
      })
      const step = registry.finalize({
        enabledTrustedTools: new Set(),
        customToolMode: "function",
        wireProtocol: "eager",
      })
      try {
        await manager.update({
          demo: { ...config.demo, env: { MCP_TEST_VALUE: "replacement" } },
        })
        expect(
          await step.execute("demo__echo", {}, { workspaceRoot: root }),
        ).toMatchObject({ content: "original" })
        expect(
          await manager.tools()[0]?.execute({}, { workspaceRoot: root }),
        ).toMatchObject({ content: "replacement" })
      } finally {
        await step.release()
        await registry.dispose()
      }
    },
    {
      installTools: (name, tools) => {
        registry.replaceExternalSource(name, tools)
      },
    },
  )
})

it("refreshes tools after a catalog notification", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:globalThis.changed?'updated':'initial',inputSchema:{type:'object'}}]});
if(m.method==='tools/call'){reply({content:[]});globalThis.changed=true;send({method:'notifications/tools/list_changed'});}`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      await manager.tools()[0]?.execute({}, { workspaceRoot: root })
      await expect
        .poll(() => manager.tools().map((tool) => tool.toolName.name))
        .toEqual(["updated"])
    },
  )
})

it("serializes overlapping configuration updates and applies raw-name filters", async () => {
  await withServer(
    `if(m.method==='tools/list')setTimeout(()=>reply({tools:['read.raw','write.raw'].map(name=>({name,inputSchema:{type:'object'}}))}),50);`,
    async ({ manager, config }) => {
      await Promise.all([
        manager.update(config),
        manager.update({
          demo: {
            ...config.demo,
            enabledTools: ["read.raw", "write.raw"],
            disabledTools: ["write.raw"],
          },
        }),
      ])
      expect(manager.status()).toEqual([
        { name: "demo", state: "ready", toolCount: 1, required: true },
      ])
      expect(manager.tools()[0]?.search?.searchText).toBe("demo read.raw")
      await manager.update({})
      expect(manager.tools()).toEqual([])
      expect(manager.status()).toEqual([])
    },
  )
})

it("keeps an installed catalog usable when an observer throws", async () => {
  const failures: unknown[] = []
  const observerError = new Error("observer failed")
  await withServer(
    `if(m.method==='tools/list')reply({tools:[{name:'read',inputSchema:{type:'object'}}]});
if(m.method==='tools/call')reply({content:[{type:'text',text:'still connected'}]});`,
    async ({ root, manager, config }) => {
      manager.subscribe(() => {
        throw observerError
      })
      await manager.update(config)
      expect(manager.status()).toEqual([
        { name: "demo", state: "ready", toolCount: 1, required: true },
      ])
      expect(
        await manager.tools()[0]?.execute({}, { workspaceRoot: root }),
      ).toMatchObject({ ok: true, content: "still connected" })
      expect(failures).toEqual([observerError])
    },
    {
      onBackgroundError: (error) => {
        failures.push(error)
      },
    },
  )
})

it("validates output and task requirements for tools on every catalog page", async () => {
  await withServer(
    `
if(m.method==='tools/list') {
 const schema={type:'object',properties:{answer:{type:'number'}},required:['answer']};
 reply(m.params?.cursor ? {tools:[{name:'last',inputSchema:{type:'object'},outputSchema:schema}]} : {
  tools:[{name:'first',inputSchema:{type:'object'},outputSchema:schema},{name:'task',inputSchema:{type:'object'},execution:{taskSupport:'required'}}],nextCursor:'next'});
}
if(m.method==='tools/call') {if(m.params.name==='task')appendFileSync(process.argv[2],'side effect');reply({content:[],structuredContent:{answer:'WRONG'}});}`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      for (const name of ["first", "last"]) {
        const tool = manager.tools().find((tool) => tool.toolName.name === name)
        expect(tool).toBeDefined()
        await expect(
          tool?.execute({}, { workspaceRoot: root }),
        ).rejects.toMatchObject({ code: -32602 })
      }
      await expect(
        manager
          .tools()
          .find((tool) => tool.toolName.name === "task")
          ?.execute({}, { workspaceRoot: root }),
      ).rejects.toMatchObject({ code: -32600 })
      await expect(readFile(join(root, "effects"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    },
  )
})

it("keeps output validation pinned while the catalog changes during a call", async () => {
  await withServer(
    `
if(m.method==='tools/list')reply({tools:[{name:'echo',description:globalThis.changed?'new':'old',inputSchema:{type:'object'},outputSchema:{$id:'https://fixture/schema',type:'object',properties:{value:{type:globalThis.changed?'integer':'string'}},required:['value']}}]});
if(m.method==='tools/call') {
 if(!globalThis.changed){globalThis.oldReply=()=>reply({content:[],structuredContent:{value:'original'}});globalThis.changed=true;send({method:'notifications/tools/list_changed'});}
 else {reply({content:[],structuredContent:{value:42}});globalThis.oldReply();}
}`,
    async ({ root, manager, config }) => {
      await manager.update(config)
      const oldTool = manager.tools()[0]
      if (oldTool === undefined) throw new Error("Missing tool")
      const pending = oldTool.execute({}, { workspaceRoot: root })
      // Attach an assertion immediately: a broken snapshot can reject during refresh.
      const oldResult = expect(pending).resolves.toMatchObject({
        ok: true,
        output: { structuredContent: { value: "original" } },
      })
      await expect.poll(() => manager.tools()[0]?.description).toBe("new")
      await expect(
        manager.tools()[0]?.execute({}, { workspaceRoot: root }),
      ).resolves.toMatchObject({
        ok: true,
        output: { structuredContent: { value: 42 } },
      })
      await oldResult
    },
  )
})

it("processes catalog changes received before initial discovery completes", async () => {
  await withServer(
    `
if(m.method==='tools/list') {
 if(!globalThis.listed){globalThis.listed=true;send({method:'notifications/tools/list_changed'});setTimeout(()=>reply({tools:[{name:'old',inputSchema:{type:'object'}}]}),40);}
 else reply({tools:[{name:'new',inputSchema:{type:'object'}}]});
}`,
    async ({ manager, config }) => {
      await manager.update(config)
      await expect
        .poll(() => manager.tools().map((tool) => tool.toolName.name))
        .toEqual(["new"])
    },
  )
})

it("allocates distinct model names for tools and server namespaces with colliding normalized names", async () => {
  const registry = createToolRegistry([])
  try {
    await withServer(
      `
if(m.method==='tools/list')reply({tools:['a.b','a_b_2e7336dc8e'].map(name=>({name,inputSchema:{type:'object'}}))});
if(m.method==='tools/call')reply({content:[{type:'text',text:m.params.name}]});`,
      async ({ root, manager, config }) => {
        await manager.update({ "a.b": config.demo })
        const originalNames = manager
          .tools()
          .map((tool) => canonicalToolName(tool.toolName))
        await manager.update({
          "a.b": config.demo,
          a_b_2e7336dc8e: config.demo,
        })
        const tools = manager.tools()
        expect(tools).toHaveLength(4)
        expect(
          new Set(tools.map((tool) => canonicalToolName(tool.toolName))).size,
        ).toBe(4)
        expect(
          tools.slice(0, 2).map((tool) => canonicalToolName(tool.toolName)),
        ).toEqual(originalNames)
        const step = registry.finalize({
          enabledTrustedTools: new Set(),
          customToolMode: "function",
          wireProtocol: "eager",
        })
        try {
          for (const tool of tools) {
            const raw = tool.search?.searchText?.split(" ").at(-1)
            expect(
              await step.execute(
                canonicalToolName(tool.toolName),
                {},
                { workspaceRoot: root },
              ),
            ).toMatchObject({ content: raw })
          }
        } finally {
          await step.release()
        }
      },
      {
        installTools: (name, tools) => {
          registry.replaceExternalSource(name, tools)
        },
      },
    )
  } finally {
    await registry.dispose()
  }
})

it("classifies HTTP 401 as authentication required without exposing the response body", async () => {
  const http = createServer((_request, response) => {
    response.writeHead(401)
    response.end("private server diagnostic")
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string")
    throw new Error("Missing listener")
  const manager = createMcpConnectionManager({ maxRestartAttempts: 0 })
  try {
    await manager.update({
      remote: { url: `http://127.0.0.1:${address.port}/mcp` },
    })
    await manager.settleConnecting(5_000)
    expect(manager.status()).toMatchObject([
      { state: "failed", errorCode: "authentication_required" },
    ])
    expect(JSON.stringify(manager.status())).not.toContain(
      "private server diagnostic",
    )
  } finally {
    await manager.close()
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
