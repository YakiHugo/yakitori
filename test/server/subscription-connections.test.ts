import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import { deferred } from "./rpc/testkit.ts"
import {
  createSubscriptionConnections,
  type SubscriptionConnections,
} from "../../src/server/subscription-connections.ts"

const directories: string[] = []
const connections: SubscriptionConnections[] = []
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  )
  vi.unstubAllEnvs()
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function loginFixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "yakitori-subscription-login-"),
  )
  directories.push(directory)
  const gate = join(directory, "finish")
  const log = join(directory, "launches")
  await writeFile(
    join(directory, "codex"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log('Sign in: https://auth.openai.com/authorize?state=test');\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(0) }, 10);\n`,
    { mode: 0o700 },
  )
  vi.stubEnv("PATH", directory)
  let available = false
  const importStarted = deferred<void>()
  const completed = vi.fn(async () => {
    available = true
  })
  const service = createSubscriptionConnections({
    readAvailability: async () => ({ codex: available, grok: false }),
    refresh: async () => {},
    importAccount: completed,
    loginCompleted: () => {
      importStarted.resolve()
      return completed()
    },
  })
  connections.push(service)
  return { service, completed, importStarted, gate, log }
}

it("imports the selected subscription and refuses to report success without an available account", async () => {
  const imported = vi.fn(async () => {})
  const service = createSubscriptionConnections({
    readAvailability: async () => ({ codex: false, grok: true }),
    refresh: async () => {},
    importAccount: imported,
    loginCompleted: async () => {},
  })
  connections.push(service)
  await expect(service.importAccount("codex", "account-json")).rejects.toThrow(
    "could not be connected",
  )
  expect(imported).toHaveBeenCalledWith("codex", "account-json")
  expect((await service.importAccount("grok"))[1]?.available).toBe(true)
  await expect(service.importAccount("unknown")).rejects.toThrow(
    "Unknown subscription",
  )
})

it("waits for a file import during shutdown and leaves its failure with the request", async () => {
  let rejectImport!: (cause: Error) => void
  const importing = new Promise<void>((_resolve, reject) => {
    rejectImport = reject
  })
  const service = createSubscriptionConnections({
    readAvailability: async () => ({ codex: true, grok: false }),
    refresh: async () => {},
    importAccount: () => importing,
    loginCompleted: async () => {},
  })
  connections.push(service)
  const result = service.importAccount("codex", "account-json")
  const failure = expect(result).rejects.toThrow("rejected by vendor")
  let closed = false
  const closing = service.close().then(() => {
    closed = true
  })
  try {
    await nextTurn()
    expect(closed).toBe(false)
  } finally {
    rejectImport(new Error("rejected by vendor"))
  }
  await failure
  await closing
  expect(closed).toBe(true)
})

it("starts one CLI login, exposes its authorization URL and imports completion", async () => {
  const { service, completed, gate, log } = await loginFixture()
  await service.login("codex")
  await service.login("codex")
  await expect
    .poll(async () => (await service.read())[0])
    .toMatchObject({
      available: false,
      login: {
        state: "running",
        url: "https://auth.openai.com/authorize?state=test",
      },
    })
  expect(await readFile(log, "utf8")).toBe("login\n")
  expect(completed).not.toHaveBeenCalled()
  await writeFile(gate, "done")
  await expect
    .poll(async () => (await service.read())[0])
    .toMatchObject({
      available: true,
      login: { state: "succeeded" },
    })
  expect(completed).toHaveBeenCalledOnce()
})

it("stops an owned login process when the application closes", async () => {
  const { service, completed } = await loginFixture()
  await service.login("codex")
  await expect
    .poll(async () => (await service.read())[0]?.login?.url)
    .toBe("https://auth.openai.com/authorize?state=test")
  await service.close()
  expect((await service.read())[0]?.login?.state).toBe("failed")
  expect(completed).not.toHaveBeenCalled()
  await expect(service.login("codex")).rejects.toThrow("closed")
})

it("reports a CLI that exits successfully without producing a usable account", async () => {
  const { service, completed, gate } = await loginFixture()
  completed.mockImplementation(async () => {})
  await service.login("codex")
  await expect
    .poll(async () => (await service.read())[0]?.login?.url)
    .toBe("https://auth.openai.com/authorize?state=test")
  await writeFile(gate, "done")
  await expect
    .poll(async () => (await service.read())[0])
    .toMatchObject({
      available: false,
      login: {
        state: "failed",
        message:
          "Sign-in finished without a usable account. Try signing in again.",
      },
    })
})

it("cancels a pending login without importing it and allows a new attempt", async () => {
  const { service, completed, log } = await loginFixture()
  await service.login("codex")
  await expect
    .poll(async () => (await service.read())[0]?.login?.url)
    .toBe("https://auth.openai.com/authorize?state=test")
  expect((await service.cancel("codex"))[0]?.login).toBeUndefined()
  expect(completed).not.toHaveBeenCalled()
  await service.login("codex")
  await expect
    .poll(async () => (await service.read())[0]?.login?.url)
    .toBe("https://auth.openai.com/authorize?state=test")
  expect(await readFile(log, "utf8")).toBe("login\nlogin\n")
})

it("waits for login persistence before a canceled sign-in can be replaced", async () => {
  const { service, completed, importStarted, gate } = await loginFixture()
  const persistence = deferred<void>()
  completed.mockImplementation(() => persistence.promise)
  await service.login("codex")
  await writeFile(gate, "done")
  // Wait for the process-exit callback itself, not a one-second mock poll.
  await importStarted.promise
  expect(completed).toHaveBeenCalledOnce()
  let canceled = false
  const canceling = service.cancel("codex").then((result) => {
    canceled = true
    return result
  })
  try {
    // Let a wrongly unblocked cancel settle before checking the barrier.
    await nextTurn()
    expect(canceled).toBe(false)
  } finally {
    persistence.resolve()
  }
  expect((await canceling)[0]?.login).toBeUndefined()
})

it("reports a missing CLI without claiming that the subscription connected", async () => {
  const { service, completed } = await loginFixture()
  await service.login("grok")
  await expect
    .poll(async () => (await service.read())[1])
    .toMatchObject({
      available: false,
      login: {
        state: "failed",
        message: "Install the grok CLI first, then try signing in again.",
      },
    })
  expect(completed).not.toHaveBeenCalled()
})
