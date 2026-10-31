import { EventEmitter } from "node:events"
import { access, readFile, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { DownloadItem, Session, WebContents } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { BrowserDownloads } from "../../src/desktop/browser-downloads.ts"

const target = {
    tabId: "owned",
    webContentsId: 17,
    instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
  },
  owner = { sessionId: "session", turnId: "turn" }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

function fixture() {
  const profile = new EventEmitter(),
    events = new EventEmitter()
  let url = "https://owned.test/",
    destroyed = false
  const contents = Object.assign(events, {
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    getURL: () => url,
  }) as unknown as WebContents
  const downloads = new BrowserDownloads(profile as unknown as Session)
  const items: {
    finish(state?: "completed" | "cancelled" | "interrupted"): void
  }[] = []
  cleanup.push(async () => {
    for (const item of items) item.finish("cancelled")
    await downloads.close()
  })
  const arm = async (expectedUrl?: string) => {
    const result = await downloads.arm(
      target,
      contents,
      owner,
      url,
      expectedUrl,
      new AbortController().signal,
    )
    if (typeof result.downloadId !== "string")
      throw new Error("Missing download token")
    return result.downloadId
  }
  const item = (
    options: {
      total?: number
      url?: string
      cancelAcknowledged?: boolean
      cancelThrows?: boolean
    } = {},
  ) => {
    const emitter = new EventEmitter(),
      cancelled = Promise.withResolvers<void>()
    let path: string | undefined,
      calls = 0,
      received = 0
    const finish = (
      state: "completed" | "cancelled" | "interrupted" = "completed",
    ) => emitter.emit("done", {}, state)
    items.push({ finish })
    const native = Object.assign(emitter, {
      getURLChain: () => [
        options.url ?? "https://owned.test/start",
        "https://files.test/final",
      ],
      getFilename: () => "../../untrusted-name.txt",
      getMimeType: () => "application/octet-stream",
      getReceivedBytes: () => received,
      getTotalBytes: () => options.total ?? 27,
      setSavePath: (value: string) => {
        path = value
      },
      cancel: () => {
        calls++
        cancelled.resolve()
        if (options.cancelThrows) throw new Error("Native item channel lost")
        if (options.cancelAcknowledged !== false) finish("cancelled")
      },
    }) as unknown as DownloadItem
    const preventDefault = vi.fn(),
      event = { preventDefault }
    return {
      native,
      emit: (source = contents) =>
        profile.emit("will-download", event, native, source),
      finish,
      preventDefault,
      cancelled,
      get path() {
        if (!path) throw new Error("Native path was not assigned")
        return path
      },
      get cancelCalls() {
        return calls
      },
      update: (bytes: number) => {
        received = bytes
        emitter.emit("updated", {}, "progressing")
      },
    }
  }
  return {
    downloads,
    contents,
    events,
    item,
    arm,
    history: (next: string) => {
      url = next
      events.emit("did-navigate-in-page", {}, url, true)
    },
    navigate: (next = url) => {
      url = next
      events.emit("did-navigate", {}, url)
    },
    destroy: () => {
      destroyed = true
      events.emit("destroyed")
    },
  }
}

it("leaves downloads unchanged until a capture rule is explicitly armed", async () => {
  const f = fixture(),
    unarmed = f.item()
  unarmed.emit()
  expect(unarmed.preventDefault).not.toHaveBeenCalled()
  const manual = f.item()
  manual.emit()
  expect(manual.preventDefault).not.toHaveBeenCalled()
})

it("captures only the matching original source, stores bytes in generated scratch paths and releases them after collection", async () => {
  const f = fixture(),
    id = await f.arm("https://owned.test/start"),
    unrelated = f.item({ url: "https://other.test/" })
  unrelated.emit()
  expect(unrelated.preventDefault).toHaveBeenCalledOnce()
  const selected = f.item()
  selected.emit()
  expect(selected.preventDefault).not.toHaveBeenCalled()
  expect(basename(selected.path)).toBe("content")
  expect(selected.path).not.toContain("untrusted-name")
  await writeFile(selected.path, "Owned download 你好 🌍\n")
  await expect(f.downloads.collect(id, target, owner)).rejects.toMatchObject({
    code: "browser_download_unready",
  })
  selected.finish()
  expect(selected.native.listenerCount("updated")).toBe(0)
  const file = await f.downloads.collect(id, target, owner)
  expect(file).toMatchObject({
    state: "completed",
    size: 27,
    path: selected.path,
    urlChain: ["https://owned.test/start", "https://files.test/final"],
  })
  expect(await readFile(selected.path, "utf8")).toBe("Owned download 你好 🌍\n")
  await f.downloads.release(id, target, owner)
  await expect(access(dirname(selected.path))).rejects.toMatchObject({
    code: "ENOENT",
  })
  expect(() => f.downloads.inspect(id, target, owner)).toThrow(
    /issued for this exact target/,
  )
})

it("does not transfer an approved rule to a reloaded document or another owning turn", async () => {
  const f = fixture(),
    id = await f.arm()
  expect(() =>
    f.downloads.inspect(id, target, { ...owner, turnId: "other" }),
  ).toThrow(/owning turn/)
  expect(() =>
    f.downloads.inspect(id, { ...target, instanceId: "replacement" }, owner),
  ).toThrow(/exact target/)
  f.events.emit("did-navigate-in-page", {}, "https://child.test/#new", false)
  expect(f.downloads.inspect(id, target, owner)).toMatchObject({
    expired: false,
  })
  f.navigate()
  const next = f.item()
  next.emit()
  expect(next.preventDefault).toHaveBeenCalledOnce()
  expect(f.downloads.inspect(id, target, owner)).toMatchObject({
    expired: true,
    state: "armed",
  })
})

it("waits for native cancellation acknowledgement before deleting a file and never replays an unknown cancel", async () => {
  const f = fixture(),
    id = await f.arm(),
    native = f.item({ cancelAcknowledged: false })
  native.emit()
  await writeFile(native.path, "partial")
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
  const cancel = f.downloads.cancel(id, target, owner),
    failed = expect(cancel).rejects.toMatchObject({
      code: "browser_cleanup_failed",
    })
  await native.cancelled.promise
  deadline.abort(new DOMException("Native cancel timeout", "TimeoutError"))
  await failed
  expect(await readFile(native.path, "utf8")).toBe("partial")
  expect(native.cancelCalls).toBe(1)
  native.finish("cancelled")
  await f.downloads.finishTurn(owner)
  expect(native.cancelCalls).toBe(1)
  await expect(access(dirname(native.path))).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("leaves an ongoing download owned when a wait is cancelled, then cancels and removes it at turn cleanup", async () => {
  const f = fixture(),
    id = await f.arm(),
    native = f.item(),
    cancel = new AbortController()
  native.emit()
  await writeFile(native.path, "partial")
  const reason = new Error("Stop waiting"),
    waiting = f.downloads.wait(id, target, owner, cancel.signal),
    stopped = expect(waiting).rejects.toBe(reason)
  cancel.abort(reason)
  await stopped
  expect(native.cancelCalls).toBe(0)
  expect(f.downloads.inspect(id, target, owner)).toMatchObject({
    state: "progressing",
  })
  await f.downloads.finishTurn(owner)
  expect(native.cancelCalls).toBe(1)
  await expect(access(dirname(native.path))).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("refuses a declared oversized transfer before a native save path can be assigned", async () => {
  const f = fixture(),
    id = await f.arm(),
    native = f.item({ total: 70_000_000 })
  native.emit()
  expect(native.preventDefault).toHaveBeenCalledOnce()
  expect(() => native.path).toThrow(/not assigned/)
  expect(f.downloads.inspect(id, target, owner)).toMatchObject({
    state: "cancelled",
    limitExceeded: true,
  })
  await expect(f.downloads.collect(id, target, owner)).rejects.toMatchObject({
    code: "browser_download_unready",
  })
})

it("retains a native cancellation exception until a late terminal event confirms the file is no longer being written", async () => {
  const f = fixture(),
    id = await f.arm(),
    native = f.item({ cancelThrows: true })
  native.emit()
  await writeFile(native.path, "partial")
  await expect(f.downloads.cancel(id, target, owner)).rejects.toMatchObject({
    code: "browser_cleanup_failed",
  })
  expect(native.cancelCalls).toBe(1)
  expect(await readFile(native.path, "utf8")).toBe("partial")
  native.finish("cancelled")
  await f.downloads.finishTurn(owner)
  expect(native.cancelCalls).toBe(1)
  await expect(access(native.path)).rejects.toMatchObject({ code: "ENOENT" })
})

it("keeps the armed capture through same-document history updates", async () => {
  const f = fixture()
  await f.arm()
  f.history("https://owned.test/receipt#download")
  const native = f.item()
  native.emit()
  expect(native.preventDefault).not.toHaveBeenCalled()
  expect(basename(native.path)).toBe("content")
})

it("keeps independent tab captures isolated and bounds simultaneous scratch writers per turn", async () => {
  const f = fixture(),
    ids: string[] = [],
    paths: string[] = []
  for (let index = 0; index < 4; index++) {
    const source = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      getURL: () => "https://owned.test/",
    }) as unknown as WebContents
    const result = await f.downloads.arm(
      { ...target, tabId: `tab_${index}`, webContentsId: index + 1 },
      source,
      owner,
      "https://owned.test/",
      undefined,
      new AbortController().signal,
    )
    if (typeof result.downloadId !== "string")
      throw new Error("Missing tab download ID")
    ids.push(result.downloadId)
    const native = f.item()
    native.emit(source)
    expect(native.preventDefault).not.toHaveBeenCalled()
    paths.push(native.path)
  }
  expect(new Set(ids).size).toBe(4)
  expect(new Set(paths).size).toBe(4)
  await expect(f.arm()).rejects.toMatchObject({ code: "browser_download_busy" })
})

it("ends a pending wait as soon as its unconsumed document rule expires", async () => {
  const f = fixture(),
    id = await f.arm(),
    waiting = f.downloads.wait(id, target, owner, new AbortController().signal)
  f.navigate("https://owned.test/new-document")
  await expect(waiting).resolves.toMatchObject({
    state: "armed",
    expired: true,
  })
})
