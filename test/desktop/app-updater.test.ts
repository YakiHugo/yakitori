import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AppUpdater } from "../../src/desktop/app-updater.ts"
import type { LocalDesktopUpdate } from "../../src/desktop/update-local.ts"
import { prepareDesktopUpdate } from "../../src/desktop/update-preparation.ts"
import {
  findDesktopUpdate,
  type ResolvedDesktopUpdate,
} from "../../src/desktop/update-release.ts"
import type {
  DesktopBuildInfo,
  DesktopUpdateState,
} from "../../src/protocol/desktop-update.ts"

vi.mock("../../src/desktop/update-release.ts", () => ({
  findDesktopUpdate: vi.fn(),
}))
vi.mock("../../src/desktop/update-preparation.ts", () => ({
  prepareDesktopUpdate: vi.fn(),
}))

// Discovery and native extraction/signing have separate boundary tests. These
// tests use real streamed bytes and files to protect service state and integrity.
const archive = Buffer.from("a streamed desktop update archive")
const current: DesktopBuildInfo = {
  repository: "YakiHugo/yakitori",
  version: "0.0.0",
  commit: "a".repeat(40),
  dirty: false,
  channel: "main",
  buildNumber: 41,
  buildAttempt: 1,
  builtAt: "2026-11-14T00:00:00Z",
  platform: "darwin",
  arch: "arm64",
}
const available: ResolvedDesktopUpdate = {
  release: {
    version: "0.0.0",
    commit: "b".repeat(40),
    buildNumber: 42,
    buildAttempt: 1,
    publishedAt: "2026-11-15T00:00:00Z",
    releaseUrl: "https://example.com/releases/42",
  },
  build: { ...current, commit: "b".repeat(40), buildNumber: 42 },
  archive: {
    url: "https://example.com/update.tar",
    size: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
  },
}
const fixtures: { root: string; updater: AppUpdater }[] = []

function response(bytes = archive, headers?: HeadersInit) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8))
        controller.enqueue(bytes.subarray(8))
        controller.close()
      },
    }),
    headers === undefined ? undefined : { headers },
  )
}

async function fixture(localSource?: () => Promise<LocalDesktopUpdate>) {
  const root = await mkdtemp(join(tmpdir(), "yakitori-app-updater-"))
  const applicationPath = join(root, "Yakitori.app")
  const updatesDirectory = join(root, "updates")
  await mkdir(applicationPath)
  await writeFile(join(applicationPath, "original"), "installed application")
  const states: DesktopUpdateState[] = []
  const fetchUpdate = vi.fn<typeof fetch>(async () => response())
  const install = vi.fn(
    async (_prepared: { directory: string; appPath: string }) => {},
  )
  const updater = new AppUpdater({
    current,
    applicationPath,
    updatesDirectory,
    fetch: fetchUpdate,
    onState: (state) => states.push(state),
    install,
    ...(localSource === undefined ? {} : { localSource }),
  })
  fixtures.push({ root, updater })
  return {
    updater,
    applicationPath,
    updatesDirectory,
    states,
    fetchUpdate,
    install,
  }
}

beforeEach(() => {
  vi.mocked(findDesktopUpdate).mockReset()
  vi.mocked(prepareDesktopUpdate).mockReset()
  vi.mocked(findDesktopUpdate).mockResolvedValue(available)
  vi.mocked(prepareDesktopUpdate).mockImplementation(
    async ({ stageDirectory }) => {
      const appPath = join(stageDirectory, "Yakitori.app")
      await mkdir(appPath, { recursive: true })
      await writeFile(join(appPath, "prepared"), "prepared application")
      return { appPath }
    },
  )
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ root, updater }) => {
      await updater.dispose()
      await rm(root, { recursive: true, force: true })
    }),
  )
  vi.restoreAllMocks()
})

it("coalesces concurrent checks and publishes the discovered release", async () => {
  const discovery = Promise.withResolvers<ResolvedDesktopUpdate | undefined>()
  vi.mocked(findDesktopUpdate).mockReturnValueOnce(discovery.promise)
  const { updater, states } = await fixture()
  expect(updater.getState()).toEqual({ phase: "idle", current })
  const first = updater.check()
  expect(updater.check()).toBe(first)
  expect(updater.getState()).toEqual({ phase: "checking", current })
  discovery.resolve(available)
  await first
  expect(states).toEqual([
    { phase: "checking", current },
    { phase: "available", current, release: available.release },
  ])
  expect(findDesktopUpdate).toHaveBeenCalledOnce()
})

it("returns to idle when discovery finds no newer release", async () => {
  vi.mocked(findDesktopUpdate).mockResolvedValueOnce(undefined)
  const { updater, states } = await fixture()
  await updater.check()
  expect(states.map((state) => state.phase)).toEqual(["checking", "idle"])
  await expect(updater.download()).rejects.toThrow("Check for an update")
})

it.each([
  {
    name: "advertised size",
    bytes: archive,
    headers: { "content-length": "1" },
    message: /size does not match/,
  },
  {
    name: "truncated stream",
    bytes: archive.subarray(0, -1),
    message: /integrity check/,
  },
  {
    name: "oversized stream",
    bytes: Buffer.concat([archive, Buffer.from("extra")]),
    message: /exceeds its published size/,
  },
  {
    name: "wrong hash",
    bytes: Buffer.alloc(archive.byteLength, 120),
    message: /integrity check/,
  },
])("rejects $name before preparation and removes downloaded files", async ({
  bytes,
  headers,
  message,
}) => {
  const { updater, fetchUpdate, updatesDirectory, applicationPath } =
    await fixture()
  fetchUpdate.mockResolvedValueOnce(response(bytes, headers))
  await updater.check()
  await updater.download()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "download",
    message,
  })
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
  expect(await readdir(updatesDirectory)).toEqual([])
  expect(await readdir(applicationPath)).toEqual(["original"])
  expect(await readFile(join(applicationPath, "original"), "utf8")).toBe(
    "installed application",
  )
})

it("streams the verified archive and becomes ready only after preparation resolves", async () => {
  const enteredPreparation = Promise.withResolvers<void>()
  const preparation = Promise.withResolvers<{ appPath: string }>()
  let archivePath: string | undefined
  vi.mocked(prepareDesktopUpdate).mockImplementationOnce(async (input) => {
    archivePath = input.archivePath
    expect(await readFile(input.archivePath)).toEqual(archive)
    enteredPreparation.resolve()
    return preparation.promise
  })
  const { updater, states, updatesDirectory } = await fixture()
  await updater.check()
  const download = updater.download()
  expect(updater.download()).toBe(download)
  await enteredPreparation.promise
  expect(updater.getState()).toMatchObject({ phase: "preparing" })
  expect(states.some((state) => state.phase === "ready")).toBe(false)
  const completed = states
    .filter((state) => state.phase === "downloading")
    .at(-1)
  expect(completed).toMatchObject({
    downloadedBytes: archive.byteLength,
    totalBytes: archive.byteLength,
  })
  preparation.resolve({ appPath: join(updatesDirectory, "prepared.app") })
  await download
  expect(updater.getState()).toEqual({
    phase: "ready",
    current,
    release: available.release,
  })
  expect(archivePath).toBeDefined()
  await expect(readFile(archivePath as string)).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("cleans failed preparation and can download again", async () => {
  vi.mocked(prepareDesktopUpdate).mockRejectedValueOnce(
    new Error("Could not prepare application"),
  )
  const { updater, updatesDirectory, fetchUpdate } = await fixture()
  await updater.check()
  await updater.download()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "download",
    message: "Could not prepare application",
  })
  expect(await readdir(updatesDirectory)).toEqual([])
  await updater.download()
  expect(updater.getState()).toMatchObject({ phase: "ready" })
  expect(fetchUpdate).toHaveBeenCalledTimes(2)
})

it("requires a prepared update and allows retrying a failed installer handoff", async () => {
  const { updater, install } = await fixture()
  await expect(updater.install()).rejects.toThrow("not ready")
  await updater.check()
  await expect(updater.install()).rejects.toThrow("not ready")
  expect(install).not.toHaveBeenCalled()
  await updater.download()
  install.mockRejectedValueOnce(new Error("Could not start the installer"))
  await updater.install()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "install",
    message: "Could not start the installer",
  })
  await updater.install()
  expect(updater.getState()).toMatchObject({ phase: "installing" })
  expect(install).toHaveBeenCalledTimes(2)
})

it("coalesces installer handoffs and retains the worker-owned stage across disposal", async () => {
  const handoff = Promise.withResolvers<void>()
  const { updater, install } = await fixture()
  await updater.check()
  await updater.download()
  install.mockReturnValueOnce(handoff.promise)
  const installing = updater.install()
  expect(updater.install()).toBe(installing)
  const prepared = install.mock.calls[0]?.[0]
  expect(prepared).toBeDefined()
  handoff.resolve()
  await installing
  await updater.install()
  expect(install).toHaveBeenCalledOnce()
  await updater.dispose()
  expect(
    await readFile(join(prepared?.appPath ?? "", "prepared"), "utf8"),
  ).toBe("prepared application")
})

it("holds quit preparation until an in-flight installer handoff has completed", async () => {
  const handoff = Promise.withResolvers<void>()
  const { updater, install } = await fixture()
  await updater.check()
  await updater.download()
  let installerReady = false
  install.mockImplementationOnce(async () => {
    await handoff.promise
    installerReady = true
  })
  const installing = updater.install()
  let quitPrepared = false
  const preparingQuit = updater.waitForInstaller().then(() => {
    expect(installerReady).toBe(true)
    quitPrepared = true
  })
  await Promise.resolve()
  expect(quitPrepared).toBe(false)
  handoff.resolve()
  await Promise.all([installing, preparingQuit])
  expect(quitPrepared).toBe(true)
})

it("returns a canceled restart to ready and reclaims staging for disposal", async () => {
  const { updater, updatesDirectory } = await fixture()
  await updater.check()
  await updater.download()
  await updater.install()
  updater.cancelInstallation()
  expect(updater.getState()).toMatchObject({ phase: "ready" })
  await updater.dispose()
  expect(await readdir(updatesDirectory)).toEqual([])
})

it("removes an unused ready stage when disposed", async () => {
  const { updater, updatesDirectory } = await fixture()
  await updater.check()
  await updater.download()
  expect((await readdir(updatesDirectory)).length).toBe(1)
  await updater.dispose()
  expect(await readdir(updatesDirectory)).toEqual([])
})

it("cleans preparation that finishes after disposal without publishing ready", async () => {
  const preparing = Promise.withResolvers<string>()
  const finishPreparation = Promise.withResolvers<{ appPath: string }>()
  vi.mocked(prepareDesktopUpdate).mockImplementationOnce(
    async ({ stageDirectory }) => {
      const appPath = join(stageDirectory, "Yakitori.app")
      await mkdir(appPath, { recursive: true })
      preparing.resolve(appPath)
      return finishPreparation.promise
    },
  )
  const { updater, states, updatesDirectory } = await fixture()
  await updater.check()
  const downloading = updater.download()
  const appPath = await preparing.promise
  const disposing = updater.dispose()
  finishPreparation.resolve({ appPath })
  await Promise.all([downloading, disposing])
  expect(await readdir(updatesDirectory)).toEqual([])
  expect(states.at(-1)?.phase).toBe("preparing")
  expect(states.some((state) => state.phase === "ready")).toBe(false)
})

it("aborts discovery on disposal and stops publishing updates", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  vi.mocked(findDesktopUpdate).mockImplementationOnce(
    async (_current, options) => {
      await options?.fetch?.("https://example.com/releases")
      return available
    },
  )
  const { updater, fetchUpdate, states } = await fixture()
  fetchUpdate.mockImplementationOnce(async (_input, init) => {
    const signal = init?.signal
    if (!signal) throw new Error("Missing cancellation signal")
    started.resolve(signal)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })
  })
  const check = updater.check()
  const signal = await started.promise
  await updater.dispose()
  await check
  expect(signal.aborted).toBe(true)
  expect(states.map((state) => state.phase)).toEqual(["checking"])
})

it("aborts a pending download stream and cleans partial files on disposal", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  let cancelled = false
  const { updater, fetchUpdate, updatesDirectory, states } = await fixture()
  fetchUpdate.mockImplementationOnce(async (_input, init) => {
    if (!init?.signal) throw new Error("Missing cancellation signal")
    started.resolve(init.signal)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(archive.subarray(0, 8))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  })
  await updater.check()
  const downloading = updater.download()
  const signal = await started.promise
  const count = states.length
  await updater.waitForInstaller()
  await updater.dispose()
  await downloading
  expect(signal.aborted).toBe(true)
  expect(cancelled).toBe(true)
  expect(await readdir(updatesDirectory)).toEqual([])
  expect(states).toHaveLength(count)
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
})

it("publishes actionable discovery and HTTP transport failures", async () => {
  const { updater, fetchUpdate } = await fixture()
  vi.mocked(findDesktopUpdate).mockRejectedValueOnce(
    new Error("Release service unavailable"),
  )
  await updater.check()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "check",
    message: "Release service unavailable",
  })
  await updater.check()
  fetchUpdate.mockResolvedValueOnce(new Response(null, { status: 503 }))
  await updater.download()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "download",
    message: "Could not download the update (HTTP 503).",
  })
})

const localRelease: LocalDesktopUpdate["release"] = {
  source: "local",
  version: "2.3.4",
  commit: "c".repeat(40),
  buildNumber: 0,
  buildAttempt: 0,
  publishedAt: "2026-11-16T00:00:00Z",
  releaseUrl: "",
}

it("checks and prepares a local source without remote requests and installs only on an explicit action", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const prepare = vi.fn<LocalDesktopUpdate["prepare"]>(
    async (directory, signal) => {
      expect(signal.aborted).toBe(false)
      const appPath = join(directory, "local-prepared.app")
      await mkdir(appPath)
      await writeFile(join(appPath, "prepared"), "local application")
      entered.resolve()
      await finish.promise
      return { appPath }
    },
  )
  const checkLocal = vi.fn(async () => ({ release: localRelease, prepare }))
  const { updater, states, install, fetchUpdate } = await fixture(checkLocal)
  await updater.check()
  expect(checkLocal).toHaveBeenCalledOnce()
  expect(updater.getState()).toEqual({
    phase: "available",
    current,
    release: localRelease,
  })
  expect(prepare).not.toHaveBeenCalled()
  await expect(updater.install()).rejects.toThrow(/not ready/)
  const building = updater.download()
  expect(updater.download()).toBe(building)
  await entered.promise
  expect(updater.getState()).toEqual({
    phase: "preparing",
    current,
    release: localRelease,
  })
  expect(install).not.toHaveBeenCalled()
  finish.resolve()
  await building
  expect(states.map((state) => state.phase)).toEqual([
    "checking",
    "available",
    "preparing",
    "ready",
  ])
  expect(install).not.toHaveBeenCalled()
  expect(findDesktopUpdate).not.toHaveBeenCalled()
  expect(fetchUpdate).not.toHaveBeenCalled()
  expect(prepareDesktopUpdate).not.toHaveBeenCalled()
  await updater.install()
  expect(install).toHaveBeenCalledOnce()
  expect(updater.getState()).toMatchObject({
    phase: "installing",
    release: localRelease,
  })
})

it("cleans a failed local build and retries preparation without downloading an archive", async () => {
  const prepare = vi
    .fn<LocalDesktopUpdate["prepare"]>()
    .mockImplementationOnce(async (directory) => {
      await writeFile(join(directory, "partial-build"), "unfinished")
      throw new Error("Local package failed. See build.log")
    })
    .mockImplementationOnce(async (directory) => {
      const appPath = join(directory, "local-prepared.app")
      await mkdir(appPath)
      return { appPath }
    })
  const { updater, updatesDirectory, fetchUpdate, install } = await fixture(
    async () => ({
      release: localRelease,
      prepare,
    }),
  )
  await updater.check()
  await updater.download()
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "download",
    release: localRelease,
    message: "Local package failed. See build.log",
  })
  expect(await readdir(updatesDirectory)).toEqual([])
  await updater.download()
  expect(updater.getState()).toMatchObject({
    phase: "ready",
    release: localRelease,
  })
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(fetchUpdate).not.toHaveBeenCalled()
  expect(findDesktopUpdate).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
})

it("aborts local preparation and cleans its stage on disposal without publishing an error or ready state", async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const prepare = vi.fn<LocalDesktopUpdate["prepare"]>(
    async (directory, signal) => {
      await writeFile(join(directory, "partial-build"), "unfinished")
      entered.resolve(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })
    },
  )
  const { updater, updatesDirectory, states, fetchUpdate, install } =
    await fixture(async () => ({
      release: localRelease,
      prepare,
    }))
  await updater.check()
  const building = updater.download()
  const signal = await entered.promise
  await updater.dispose()
  await building
  expect(signal.aborted).toBe(true)
  expect(await readdir(updatesDirectory)).toEqual([])
  expect(states.map((state) => state.phase)).toEqual([
    "checking",
    "available",
    "preparing",
  ])
  expect(fetchUpdate).not.toHaveBeenCalled()
  expect(findDesktopUpdate).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
})

it("reports local source discovery failures without falling back to remote release discovery", async () => {
  const { updater, states, fetchUpdate } = await fixture(async () => {
    throw new Error("Choose the root of the local Yakitori repository.")
  })
  await updater.check()
  expect(states.map((state) => state.phase)).toEqual(["checking", "error"])
  expect(updater.getState()).toMatchObject({
    phase: "error",
    retry: "check",
    message: "Choose the root of the local Yakitori repository.",
  })
  expect(findDesktopUpdate).not.toHaveBeenCalled()
  expect(fetchUpdate).not.toHaveBeenCalled()
})
