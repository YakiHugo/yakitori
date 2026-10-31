import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DownloadItem, Event, Session, WebContents } from "electron"
import {
  BrowserControlError,
  type BrowserOwner,
  type BrowserTarget,
  browserDownloadSafetyBytes,
  isBrowserDownloadUrl,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

type Download = {
  id: string
  owner: BrowserOwner
  target: BrowserTarget
  contents: WebContents
  fromUrl: string
  expectedUrl?: string
  root?: string
  ready: boolean
  expired: boolean
  state: "armed" | "progressing" | "completed" | "cancelled" | "interrupted"
  item?: DownloadItem
  updated?: () => void
  receivedBytes: number
  totalBytes: number
  filename: string
  mimeType: string
  urls: string[]
  limitExceeded: boolean
  waiters: Set<() => void>
  cancelRequested: boolean
  cancelFailure?: unknown
  navigated: () => void
  destroyed: () => void
}

// Incoming bytes live only in generated scratch paths. Native progress events
// can lag writes: this stops observed oversized transfers, not an exact disk quota.

export class BrowserDownloads {
  readonly #profile: Session
  readonly #jobs = new Map<string, Download>()
  readonly #byContents = new Map<WebContents, Download>()
  #closing = false
  readonly #willDownload = (
    event: Event,
    item: DownloadItem,
    contents: WebContents,
  ) => {
    const job = this.#byContents.get(contents)
    // Read-only observation must not intercept a page's downloads. Only an
    // explicitly armed tab yields its native picker to this capture scope.
    if (!job) return
    const urls = item.getURLChain()
    if (
      this.#closing ||
      !urls.length ||
      !isBrowserDownloadUrl(urls[0] ?? "") ||
      !job?.ready ||
      job.item ||
      job.state !== "armed" ||
      job.expired ||
      (job.expectedUrl !== undefined && urls[0] !== job.expectedUrl)
    ) {
      event.preventDefault()
      return
    }
    if (!job.root)
      throw new Error("An armed download has no scratch directory.")
    job.receivedBytes = item.getReceivedBytes()
    job.totalBytes = item.getTotalBytes()
    job.filename = item.getFilename().slice(0, 4097)
    job.mimeType = item.getMimeType().slice(0, 1025)
    job.urls = urls.slice(0, 17).map((url) => url.slice(0, 8193))
    if (job.totalBytes > browserDownloadSafetyBytes) {
      event.preventDefault()
      job.limitExceeded = true
      job.state = "cancelled"
      this.#settle(job)
      return
    }
    job.item = item
    job.state = "progressing"
    job.updated = () => {
      if (job.state !== "progressing") return
      job.receivedBytes = item.getReceivedBytes()
      job.totalBytes = item.getTotalBytes()
      if (
        job.receivedBytes > browserDownloadSafetyBytes ||
        job.totalBytes > browserDownloadSafetyBytes
      ) {
        job.limitExceeded = true
        this.#requestCancel(job)
      }
    }
    item.on("updated", job.updated)
    item.once("done", (_event, state) => {
      if (job.updated) item.off("updated", job.updated)
      delete job.updated
      job.receivedBytes = item.getReceivedBytes()
      job.totalBytes = item.getTotalBytes()
      job.urls = item
        .getURLChain()
        .slice(0, 17)
        .map((url) => url.slice(0, 8193))
      job.limitExceeded ||=
        job.receivedBytes > browserDownloadSafetyBytes ||
        job.totalBytes > browserDownloadSafetyBytes
      job.state = state
      this.#settle(job)
    })
    item.setSavePath(join(job.root, "content"))
  }

  constructor(profile: Session) {
    this.#profile = profile
    profile.on("will-download", this.#willDownload)
  }

  async arm(
    target: BrowserTarget,
    contents: WebContents,
    owner: BrowserOwner,
    fromUrl: string,
    expectedUrl: string | undefined,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    if (
      this.#closing ||
      this.#byContents.has(contents) ||
      // Bound simultaneous native scratch writers while allowing independent
      // tabs to download during the same owning turn.
      [...this.#jobs.values()].filter(
        (job) =>
          job.owner.sessionId === owner.sessionId &&
          job.owner.turnId === owner.turnId,
      ).length >= 4
    )
      throw new BrowserControlError(
        "browser_download_busy",
        "Collect or cancel the existing owned download before arming another one.",
      )
    // Bound retained native objects and scratch directories across orphan owners.
    if (this.#jobs.size >= 16)
      throw new BrowserControlError(
        "browser_download_busy",
        "The host safety boundary is sixteen retained download records.",
      )
    if (
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      contents.getURL() !== fromUrl
    )
      throw new BrowserControlError(
        "browser_target_changed",
        "Observe the current browser document before arming its next download.",
      )
    const job: Download = {
      id: `browser_download_${randomUUID()}`,
      owner,
      target,
      contents,
      fromUrl,
      ...(expectedUrl === undefined ? {} : { expectedUrl }),
      ready: false,
      expired: false,
      state: "armed",
      receivedBytes: 0,
      totalBytes: 0,
      filename: "",
      mimeType: "",
      urls: [],
      limitExceeded: false,
      waiters: new Set(),
      cancelRequested: false,
      navigated: () => {
        job.expired = true
        if (job.state === "armed") this.#settle(job)
      },
      destroyed: () => {
        job.expired = true
        if (job.state === "armed") this.#settle(job)
        if (job.item && job.state === "progressing") this.#requestCancel(job)
      },
    }
    this.#jobs.set(job.id, job)
    this.#byContents.set(contents, job)
    contents.on("did-navigate", job.navigated)
    contents.on("destroyed", job.destroyed)
    try {
      job.root = await mkdtemp(join(tmpdir(), "yakitori-browser-download-"))
      signal.throwIfAborted()
      if (
        job.expired ||
        contents.isDestroyed() ||
        contents.getURL() !== fromUrl
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The original download document changed while arming.",
        )
      job.ready = true
      return this.#snapshot(job)
    } catch (cause) {
      await this.#remove(job)
      throw cause
    }
  }

  #require(id: string, target: BrowserTarget, owner: BrowserOwner): Download {
    const job = this.#jobs.get(id)
    if (
      !job ||
      job.target.instanceId !== target.instanceId ||
      job.target.tabId !== target.tabId ||
      job.target.webContentsId !== target.webContentsId ||
      job.owner.sessionId !== owner.sessionId ||
      job.owner.turnId !== owner.turnId
    )
      throw new BrowserControlError(
        "browser_download_stale",
        "Use a download ID issued for this exact target and owning turn.",
      )
    return job
  }

  #snapshot(job: Download): JsonObject {
    return {
      downloadId: job.id,
      fromUrl: job.fromUrl,
      state: job.state,
      expired: job.expired,
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
      filename: job.filename.slice(0, 4096),
      mimeType: job.mimeType.slice(0, 1024),
      urlChain: job.urls.slice(0, 16).map((url) => url.slice(0, 8192)),
      metadataTruncated:
        job.filename.length > 4096 ||
        job.mimeType.length > 1024 ||
        job.urls.length > 16 ||
        job.urls.some((url) => url.length > 8192),
      limitExceeded: job.limitExceeded,
    }
  }

  inspect(id: string, target: BrowserTarget, owner: BrowserOwner): JsonObject {
    return this.#snapshot(this.#require(id, target, owner))
  }

  #settle(job: Download): void {
    for (const waiter of job.waiters) waiter()
  }

  #awaitTerminal(job: Download, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (
      (job.state !== "armed" && job.state !== "progressing") ||
      (job.state === "armed" && job.expired)
    )
      return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        job.waiters.delete(done)
        signal.removeEventListener("abort", abort)
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      job.waiters.add(done)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  async wait(
    id: string,
    target: BrowserTarget,
    owner: BrowserOwner,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const job = this.#require(id, target, owner),
      deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      await this.#awaitTerminal(job, deadline)
    } catch (cause) {
      if (!deadline.aborted || signal.aborted) throw cause
    }
    return this.#snapshot(job)
  }

  #requestCancel(job: Download): void {
    if (job.cancelRequested) return
    if (!job.item) throw new Error("An active download lost its native item.")
    job.cancelRequested = true
    try {
      job.item.cancel()
    } catch (cause) {
      job.cancelFailure = cause
    }
  }

  async #cancel(job: Download): Promise<void> {
    job.ready = false
    if (job.state === "progressing") {
      if (!job.item) throw new Error("An active download lost its native item.")
      this.#requestCancel(job)
      if (job.cancelFailure)
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "Native download cancellation lost its completion channel.",
          { cause: job.cancelFailure },
        )
      const deadline = AbortSignal.timeout(10_000)
      try {
        await this.#awaitTerminal(job, deadline)
      } catch (cause) {
        if (!deadline.aborted) throw cause
        throw new BrowserControlError(
          "browser_cleanup_failed",
          "Native download cancellation has no terminal acknowledgement. Keep computer input paused until cleanup succeeds.",
          { cause },
        )
      }
    } else if (job.state === "armed") {
      job.state = "cancelled"
      this.#settle(job)
    }
  }

  async cancel(
    id: string,
    target: BrowserTarget,
    owner: BrowserOwner,
  ): Promise<JsonObject> {
    const job = this.#require(id, target, owner)
    await this.#cancel(job)
    const snapshot = this.#snapshot(job)
    await this.#remove(job)
    return snapshot
  }

  async collect(
    id: string,
    target: BrowserTarget,
    owner: BrowserOwner,
  ): Promise<JsonObject> {
    const job = this.#require(id, target, owner)
    if (job.state !== "completed" || !job.root || job.limitExceeded)
      throw new BrowserControlError(
        "browser_download_unready",
        "Only a completed download within the observed transfer safety boundary can be collected.",
      )
    const path = join(job.root, "content"),
      info = await lstat(path)
    if (!info.isFile() || info.size > browserDownloadSafetyBytes)
      throw new BrowserControlError(
        "browser_download_unavailable",
        "The completed native download is not a bounded regular file.",
      )
    return { ...this.#snapshot(job), path, size: info.size }
  }

  async release(
    id: string,
    target: BrowserTarget,
    owner: BrowserOwner,
  ): Promise<void> {
    const job = this.#require(id, target, owner)
    if (job.state === "armed" || job.state === "progressing")
      throw new BrowserControlError(
        "browser_download_unready",
        "Cancel an unfinished download before releasing its scratch file.",
      )
    await this.#remove(job)
  }

  async #remove(job: Download): Promise<void> {
    job.ready = false
    if (job.root) await rm(job.root, { recursive: true, force: true })
    job.contents.off("did-navigate", job.navigated)
    job.contents.off("destroyed", job.destroyed)
    this.#jobs.delete(job.id)
    if (this.#byContents.get(job.contents) === job)
      this.#byContents.delete(job.contents)
  }

  async #finishJobs(jobs: Download[]): Promise<void> {
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        await this.#cancel(job)
        await this.#remove(job)
      }),
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    )
    if (failures.length)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Owned download cleanup could not be confirmed.",
        { cause: new AggregateError(failures) },
      )
  }

  finishTurn(owner: BrowserOwner): Promise<void> {
    return this.#finishJobs(
      [...this.#jobs.values()].filter(
        (job) =>
          job.owner.sessionId === owner.sessionId &&
          job.owner.turnId === owner.turnId,
      ),
    )
  }

  finishSession(sessionId: string): Promise<void> {
    return this.#finishJobs(
      [...this.#jobs.values()].filter(
        (job) => job.owner.sessionId === sessionId,
      ),
    )
  }

  async close(): Promise<void> {
    this.#closing = true
    await this.#finishJobs([...this.#jobs.values()])
    this.#profile.off("will-download", this.#willDownload)
  }
}
