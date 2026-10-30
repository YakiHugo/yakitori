import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import { spawnServerProcess } from "../../src/desktop/server-process.ts"
import {
  BrowserControlError,
  type DesktopBrowser,
  parseBrowserObservationRequest,
} from "../../src/protocol/desktop-browser.ts"

it("accepts only exact browser observation targets and rejects arbitrary protocol commands", () => {
  expect(
    parseBrowserObservationRequest({
      action: "observe",
      target: {
        tabId: "owned",
        webContentsId: 17,
        instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
      },
    }),
  ).toEqual({
    action: "observe",
    target: {
      tabId: "owned",
      webContentsId: 17,
      instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
    },
  })
  for (const input of [
    { action: "cdp", method: "Browser.getBrowserCommandLine" },
    {
      action: "observe",
      target: {
        tabId: "owned",
        webContentsId: 0,
        instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
      },
    },
    { action: "observe", target: { tabId: "owned", webContentsId: 17 } },
    {
      action: "observe",
      target: { tabId: "owned", webContentsId: 17, instanceId: "bad" },
    },
    {
      action: "observe",
      target: {
        tabId: "owned",
        webContentsId: 17,
        instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
        url: "file:///secret",
      },
    },
    {
      action: "list",
      target: {
        tabId: "owned",
        webContentsId: 17,
        instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
      },
    },
    { action: "list", offset: -1 },
  ])
    expect(() => parseBrowserObservationRequest(input)).toThrow("Use list")
})

it("does not retain browser IPC when application startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "yakitori-browser-startup-"))
  const workspace = join(root, "not-a-directory"),
    script = join(root, "startup.mjs")
  await writeFile(workspace, "fixture")
  await writeFile(
    script,
    `
import {runYakitoriServerProcess} from ${JSON.stringify(pathToFileURL(resolve("src/server/server-process.ts")).href)};
try {await runYakitoriServerProcess({host:'127.0.0.1',port:0,application:{rootDir:${JSON.stringify(join(root, "store"))},workspace:${JSON.stringify(workspace)},provider:'faux'},onListening(){throw new Error('Unexpected listening server')}})}
catch(error){process.send({error:error.message})}
`,
  )
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, YAKITORI_DESKTOP_BROWSER: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let failure: unknown,
    stderr = ""
  child.on("message", (message) => {
    failure = message
  })
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-16000)
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const [code, signal] = await once(child, "exit")
    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null })
    expect(failure).toMatchObject({
      error: expect.stringContaining("not a directory"),
    })
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

async function fixture(
  browser: Pick<DesktopBrowser, "request"> &
    Partial<Pick<DesktopBrowser, "finishTurn" | "closeSession">>,
) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-browser-ipc-"))
  const script = join(root, "child.mjs")
  await writeFile(
    script,
    `
import {createDesktopBrowserClient} from ${JSON.stringify(pathToFileURL(resolve("src/server/desktop-browser.ts")).href)};
const client=createDesktopBrowserClient();const cancellation=new AbortController();
process.on('message',async message=>{
 if(message.type==='test/abort') cancellation.abort();
 if(!['test/request','test/finish'].includes(message.type)) return;
 try { const owner={sessionId:"session_owned",turnId:"turn_owned"}; const result=message.type==='test/finish'?await client.finishTurn(owner).then(()=>({finished:true})):await client.request(message.input,owner,cancellation.signal);process.send({type:'test/result',operation:message.type,ok:true,result}); }
 catch(error) {process.send({type:'test/result',operation:message.type,ok:false,code:error.code,message:error.message});}
});
process.on('SIGTERM',()=>{client.close();process.exit(0)});
console.log('yakitori-listening http://127.0.0.1:1');
`,
  )
  try {
    const server = await spawnServerProcess({
      command: process.execPath,
      args: [script],
      desktopBrowser: {
        async finishTurn() {},
        async closeSession() {},
        ...browser,
      },
    })
    const nextResult = (operation = "test/request") =>
      new Promise<unknown>((resolve) => {
        const receive = (message: unknown) => {
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message) ||
            message.type !== "test/result" ||
            !("operation" in message) ||
            message.operation !== operation
          )
            return
          server.child.off("message", receive)
          resolve(message)
        }
        server.child.on("message", receive)
      })
    return {
      server,
      nextResult,
      async close() {
        await server.stop()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (cause) {
    await rm(root, { recursive: true, force: true })
    throw cause
  }
}

it("round-trips a real sidecar browser request without exposing attachment IPC", async () => {
  const input = {
    action: "observe",
    target: {
      tabId: "owned",
      webContentsId: 17,
      instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
    },
  } as const
  const f = await fixture({
    async request(request) {
      return { received: request }
    },
  })
  try {
    const result = f.nextResult()
    f.server.child.send({ type: "test/request", input })
    expect(await result).toEqual({
      type: "test/result",
      operation: "test/request",
      ok: true,
      result: { received: input },
    })
  } finally {
    await f.close()
  }
})

it("waits for parent cancellation acknowledgement and discards a late successful frame", async () => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const f = await fixture({
    async request(_input, _owner, signal) {
      if (!signal) throw new Error("Missing cancellation signal")
      started.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve()
            resolve()
          },
          { once: true },
        ),
      )
      await release.promise
      return { late: "frame" }
    },
  })
  try {
    let completed = false
    const result = f.nextResult().then((value) => {
      completed = true
      return value
    })
    f.server.child.send({ type: "test/request", input: { action: "list" } })
    await started.promise
    f.server.child.send({ type: "test/abort" })
    await aborted.promise
    expect(completed).toBe(false)
    release.resolve()
    expect(await result).toMatchObject({ ok: false, code: "browser_cancelled" })
  } finally {
    release.resolve()
    await f.close()
  }
})

it("drains pending requests before acknowledging the owning turn cleanup", async () => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    releaseRead = Promise.withResolvers<void>(),
    cleaning = Promise.withResolvers<void>(),
    releaseCleanup = Promise.withResolvers<void>()
  const f = await fixture({
    async request(_input, owner, signal) {
      expect(owner).toEqual({
        sessionId: "session_owned",
        turnId: "turn_owned",
      })
      started.resolve()
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
      await releaseRead.promise
      return { late: true }
    },
    async finishTurn(owner) {
      expect(owner).toEqual({
        sessionId: "session_owned",
        turnId: "turn_owned",
      })
      cleaning.resolve()
      await releaseCleanup.promise
    },
  })
  try {
    const read = f.nextResult()
    f.server.child.send({ type: "test/request", input: { action: "list" } })
    await started.promise
    let finished = false
    const cleanup = f.nextResult("test/finish").then((result) => {
      finished = true
      return result
    })
    f.server.child.send({ type: "test/finish" })
    await aborted.promise
    expect(finished).toBe(false)
    releaseRead.resolve()
    expect(await read).toMatchObject({ ok: false, code: "browser_cancelled" })
    await cleaning.promise
    expect(finished).toBe(false)
    releaseCleanup.resolve()
    expect(await cleanup).toMatchObject({
      ok: true,
      result: { finished: true },
    })
  } finally {
    releaseRead.resolve()
    releaseCleanup.resolve()
    await f.close()
  }
})

it("preserves browser cleanup failure across the process boundary", async () => {
  const f = await fixture({
    async request() {
      return {}
    },
    async finishTurn() {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The owned debugger could not detach.",
      )
    },
  })
  try {
    const result = f.nextResult("test/finish")
    f.server.child.send({ type: "test/finish" })
    expect(await result).toMatchObject({
      ok: false,
      code: "browser_cleanup_failed",
    })
  } finally {
    await f.close()
  }
})

it("cleans idle browser ownership when its sidecar exits between model steps", async () => {
  const closed: string[] = []
  const f = await fixture({
    async request() {
      return { tabs: [] }
    },
    async closeSession(sessionId) {
      closed.push(sessionId)
    },
  })
  try {
    const read = f.nextResult()
    f.server.child.send({ type: "test/request", input: { action: "list" } })
    expect(await read).toMatchObject({ ok: true })
  } finally {
    await f.close()
  }
  await expect.poll(() => closed).toEqual(["session_owned"])
})

it("cancels a timed-out text dispatch without abandoning its acknowledgement", async () => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const f = await fixture({
    async request(_input, _owner, signal) {
      started.resolve()
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
      await release.promise
      return { late: true }
    },
  })
  try {
    let completed = false
    const result = f.nextResult().then((value) => {
      completed = true
      return value
    })
    f.server.child.send({
      type: "test/request",
      input: {
        action: "type",
        target: {
          tabId: "owned",
          webContentsId: 17,
          instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
        },
        reference: "browser_node_00000000-0000-4000-8000-000000000001",
        text: "Only once",
      },
    })
    await started.promise
    await aborted.promise
    expect(completed).toBe(false)
    release.resolve()
    expect(await result).toMatchObject({
      ok: false,
      code: "browser_input_unconfirmed",
    })
  } finally {
    release.resolve()
    await f.close()
  }
}, 20_000)
