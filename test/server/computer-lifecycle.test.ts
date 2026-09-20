import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ModelStopReason, type StreamFn } from "../../src/runtime/model.ts"
import {
  createYakitoriApplication,
  type YakitoriApplication,
} from "../../src/server/application.ts"
import type { ApiHandlerResult } from "../../src/server/protocol.ts"

function body<T>(response: ApiHandlerResult<T>): T {
  if (!response.ok) throw new Error(JSON.stringify(response.body))
  return response.body
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for lifecycle state.")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(waitForFirstAbort = false) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-computer-lifecycle-"))
  const script = join(root, "mcp.mjs")
  const calls = join(root, "calls.txt")
  const cleanupInputs = join(root, "cleanup-inputs.jsonl")
  const release = join(root, "release")
  const fail = join(root, "fail")
  await writeFile(calls, "")
  await writeFile(cleanupInputs, "")
  await writeFile(
    script,
    [
      "import {appendFileSync,existsSync} from 'node:fs';",
      "import readline from 'node:readline';",
      `const calls=${JSON.stringify(calls)},cleanupInputs=${JSON.stringify(cleanupInputs)},release=${JSON.stringify(release)},fail=${JSON.stringify(fail)};`,
      "const cleanupKeys=['hook_event_name','session_id','turn_id'];",
      "const cleanupSchema={type:'object',properties:Object.fromEntries(cleanupKeys.map(key=>[key,{type:'string',minLength:1}])),required:cleanupKeys,additionalProperties:false};",
      "readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;",
      "const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');",
      "if(m.method==='tools/list')return reply({tools:['js','turn_ended'].map(name=>({name,description:'computer tool',inputSchema:name==='turn_ended'?cleanupSchema:{type:'object'}}))});",
      "if(m.method!=='tools/call')return reply({protocolVersion:m.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});",
      "const name=m.params.name;appendFileSync(calls,name+':'+(m.params.arguments?.label??'start')+'\\n');",
      "if(name==='turn_ended'){const args=m.params.arguments;",
      "if(typeof args!=='object'||args===null||Array.isArray(args)||Object.keys(args).length!==cleanupKeys.length||cleanupKeys.some(key=>typeof args[key]!=='string'||args[key].length===0)){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'turn_ended requires exactly hook_event_name, session_id, and turn_id as nonempty strings'}})+'\\n');return;}",
      "appendFileSync(cleanupInputs,JSON.stringify(args)+'\\n');",
      "const finish=()=>{appendFileSync(calls,'turn_ended:done\\n');reply({isError:existsSync(fail),content:[{type:'text',text:'released'}]});};",
      "if(existsSync(release))finish();else{const timer=setInterval(()=>{if(existsSync(release)){clearInterval(timer);finish();}},10);}return;}",
      "reply({content:[{type:'text',text:'used computer'}]});});",
    ].join("\n"),
  )
  await writeFile(
    join(root, "config.toml"),
    [
      "[mcp_servers.cua_repl]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      'enabled_tools = ["js"]',
    ].join("\n"),
  )
  const toolResults: string[] = []
  let waitingForAbort = false
  const stream: StreamFn = async function* (request) {
    const labels = new Set([
      "first",
      "second",
      "same-session",
      "other-session",
      "after-release",
    ])
    const user = [...request.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.content.some((block) => labels.has(block.text)),
      )
    if (user?.role !== "user")
      throw new Error("Fixture requires a labeled user input.")
    const label = user.content.map((block) => block.text).join("")
    const searched = request.messages.some(
      (message) =>
        message.role === "tool" && message.toolCallId === `${label}:search`,
    )
    const used = request.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === `${label}:js`,
    )
    if (used?.role === "tool") {
      toolResults.push(used.content)
      if (waitForFirstAbort && label === "first") {
        const signal = request.signal
        if (signal === undefined)
          throw new Error(
            "Cancellation fixture requires a model request signal.",
          )
        waitingForAbort = true
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        yield { type: "cancelled" }
        return
      }
      yield {
        type: "response",
        response: {
          stopReason: ModelStopReason.EndTurn,
          content: [{ type: "text", text: "done" }],
        },
      }
      return
    }
    yield {
      type: "response",
      response: {
        stopReason: ModelStopReason.ToolUse,
        content: [
          {
            type: "tool_call",
            id: `${label}:${searched ? "js" : "search"}`,
            name: searched ? "cua_repl__js" : "tool_search",
            input: searched ? { label } : { query: "cua_repl computer js" },
          },
        ],
      },
    }
  }
  const application = await createYakitoriApplication({
    rootDir: join(root, "state"),
    workspace: root,
    userConfigPath: join(root, "config.toml"),
    provider: "openai",
    model: "gpt-test",
    stream,
  })
  return {
    application,
    calls,
    release,
    fail,
    toolResults,
    get waitingForAbort() {
      return waitingForAbort
    },
    async cleanupInputs(): Promise<unknown[]> {
      return (await readFile(cleanupInputs, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    },
    async close() {
      await writeFile(release, "")
      await application.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function input(
  application: YakitoriApplication,
  sessionId: string,
  label: string,
) {
  return body(
    await application.handlers.admitInput({
      sessionId,
      requestId: label,
      content: { kind: "text", text: label },
    }),
  )
}

async function idle(application: YakitoriApplication, sessionId: string) {
  await until(
    async () =>
      application.threadManager.getThread(sessionId)?.status === "idle",
  )
}

describe("computer ownership through application turn lifecycle", () => {
  it.each([
    false,
    true,
  ])("releases ownership after normal completion or cleanup failure (failure=%s)", async (failure) => {
    const context = await fixture()
    try {
      await writeFile(context.release, "")
      if (failure) await writeFile(context.fail, "")
      const first = body(await context.application.handlers.createSession())
      await input(context.application, first.session.id, "first")
      await idle(context.application, first.session.id)
      const stored = await context.application.threadStore.readThread(
        first.session.id,
      )
      expect(
        stored?.rollout
          .filter(({ item }) => item.type === "turn_completed")
          .map(({ item }) => item.type === "turn_completed" && item.outcome),
      ).toEqual([failure ? "failed" : "completed"])
      await rm(context.fail, { force: true })
      const second = body(await context.application.handlers.createSession())
      await input(context.application, second.session.id, "second")
      await idle(context.application, second.session.id)
      const secondStored = await context.application.threadStore.readThread(
        second.session.id,
      )
      expect(await context.cleanupInputs()).toEqual([
        {
          hook_event_name: "Stop",
          session_id: first.session.id,
          turn_id: stored?.rollout.flatMap(({ item }) =>
            item.type === "turn_started" ? [item.turnId] : [],
          )[0],
        },
        {
          hook_event_name: "Stop",
          session_id: second.session.id,
          turn_id: secondStored?.rollout.flatMap(({ item }) =>
            item.type === "turn_started" ? [item.turnId] : [],
          )[0],
        },
      ])
      expect(await readFile(context.calls, "utf8")).toBe(
        "js:first\nturn_ended:start\nturn_ended:done\njs:second\nturn_ended:start\nturn_ended:done\n",
      )
    } finally {
      await context.close()
    }
  })

  it("holds ownership after the cancellation grace period until the old turn releases the computer", async () => {
    const context = await fixture(true)
    try {
      const first = body(await context.application.handlers.createSession())
      await input(context.application, first.session.id, "first")
      await until(async () => context.waitingForAbort)
      const turnId = context.application.threadManager
        .getThread(first.session.id)
        ?.snapshot().activeTurnId
      body(
        await context.application.handlers.cancelTurn({
          sessionId: first.session.id,
          turnId,
        }),
      )
      await idle(context.application, first.session.id)
      await until(async () => (await context.cleanupInputs()).length === 1)
      expect(await context.cleanupInputs()).toEqual([
        {
          hook_event_name: "Interrupt",
          session_id: first.session.id,
          turn_id: turnId,
        },
      ])
      await input(context.application, first.session.id, "same-session")
      await idle(context.application, first.session.id)
      const second = body(await context.application.handlers.createSession())
      await input(context.application, second.session.id, "other-session")
      await idle(context.application, second.session.id)
      expect(
        context.toolResults.filter((result) => result.includes("busy")),
      ).toHaveLength(2)
      expect(await readFile(context.calls, "utf8")).toBe(
        "js:first\nturn_ended:start\n",
      )
      await writeFile(context.release, "")
      await until(async () =>
        (await readFile(context.calls, "utf8")).includes("turn_ended:done"),
      )
      await input(context.application, second.session.id, "after-release")
      await idle(context.application, second.session.id)
      expect(await readFile(context.calls, "utf8")).toContain(
        "js:after-release\n",
      )
    } finally {
      await context.close()
    }
  })
})
