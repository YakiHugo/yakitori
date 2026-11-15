import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import type {
  DesktopBuildInfo,
  DesktopUpdateState,
} from "../protocol/desktop-update.ts"
import { removeUpdateDirectory } from "./update-filesystem.ts"
import { prepareDesktopUpdate } from "./update-preparation.ts"
import {
  findDesktopUpdate,
  type ResolvedDesktopUpdate,
} from "./update-release.ts"

// Abort a stalled transfer, without imposing a total download-time limit.
const downloadIdleTimeoutMs = 60_000
const progressNotificationIntervalMs = 100

export class AppUpdater {
  private state: DesktopUpdateState
  private available: ResolvedDesktopUpdate | undefined
  private prepared: { directory: string; appPath: string } | undefined
  private operation: Promise<void> | undefined
  private activeAbort: AbortController | undefined
  private disposed = false
  private installerOwnsStage = false

  constructor(
    private readonly options: Readonly<{
      current: DesktopBuildInfo
      applicationPath: string
      updatesDirectory: string
      onState(state: DesktopUpdateState): void
      install(prepared: { directory: string; appPath: string }): Promise<void>
      fetch?: typeof fetch
      previousInstallationError?: string
    }>,
  ) {
    this.state =
      options.previousInstallationError === undefined
        ? { phase: "idle", current: options.current }
        : {
            phase: "error",
            current: options.current,
            message: options.previousInstallationError,
            retry: "check",
          }
  }

  getState(): DesktopUpdateState {
    return this.state
  }

  private publish(state: DesktopUpdateState): void {
    this.state = state
    if (!this.disposed) this.options.onState(state)
  }

  private fail(error: unknown, retry: "check" | "download" | "install"): void {
    console.error("yakitori: application update failed", error)
    this.publish({
      phase: "error",
      current: this.options.current,
      ...(this.available === undefined
        ? {}
        : { release: this.available.release }),
      message: error instanceof Error ? error.message : String(error),
      retry,
    })
  }

  check(): Promise<void> {
    if (this.disposed || this.prepared !== undefined) return Promise.resolve()
    if (this.operation !== undefined) return this.operation
    this.operation = this.checkAvailable().finally(() => {
      this.operation = undefined
    })
    return this.operation
  }

  private async checkAvailable(): Promise<void> {
    this.publish({ phase: "checking", current: this.options.current })
    const controller = new AbortController()
    this.activeAbort = controller
    try {
      const fetchRelease: typeof fetch = (input, init) =>
        (this.options.fetch ?? fetch)(input, {
          ...init,
          signal:
            init?.signal == null
              ? controller.signal
              : AbortSignal.any([controller.signal, init.signal]),
        })
      this.available = await findDesktopUpdate(this.options.current, {
        fetch: fetchRelease,
      })
      this.publish(
        this.available === undefined
          ? { phase: "idle", current: this.options.current }
          : {
              phase: "available",
              current: this.options.current,
              release: this.available.release,
            },
      )
    } catch (error) {
      if (!this.disposed) this.fail(error, "check")
    } finally {
      this.activeAbort = undefined
    }
  }

  download(): Promise<void> {
    if (this.disposed || this.prepared !== undefined) return Promise.resolve()
    if (this.operation !== undefined) return this.operation
    const available = this.available
    if (available === undefined)
      return Promise.reject(
        new Error("Check for an update before downloading."),
      )
    this.operation = this.downloadAvailable(available).finally(() => {
      this.operation = undefined
    })
    return this.operation
  }

  private async downloadAvailable(
    available: ResolvedDesktopUpdate,
  ): Promise<void> {
    let directory: string | undefined
    const controller = new AbortController()
    this.activeAbort = controller
    const stall = () =>
      controller.abort(new Error("The update download stalled. Try again."))
    let idle = setTimeout(stall, downloadIdleTimeoutMs)
    const progress = (downloadedBytes: number) => {
      this.publish({
        phase: "downloading",
        current: this.options.current,
        release: available.release,
        downloadedBytes,
        totalBytes: available.archive.size,
      })
    }
    progress(0)
    try {
      await mkdir(this.options.updatesDirectory, { recursive: true })
      directory = await realpath(
        await mkdtemp(path.join(this.options.updatesDirectory, "download-")),
      )
      const archivePath = path.join(directory, "update.tar")
      const response = await (this.options.fetch ?? fetch)(
        available.archive.url,
        {
          signal: controller.signal,
          headers: {
            "User-Agent": "Yakitori desktop updater",
            Accept: "application/octet-stream",
            "Accept-Encoding": "identity",
          },
        },
      )
      if (!response.ok || response.body === null)
        throw new Error(
          `Could not download the update (HTTP ${response.status}).`,
        )
      const advertised = response.headers.get("content-length")
      if (advertised !== null && Number(advertised) !== available.archive.size)
        throw new Error("The update download size does not match its release.")
      let downloaded = 0
      let lastNotification = 0
      const hash = createHash("sha256")
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            downloaded += chunk.byteLength
            if (downloaded > available.archive.size) {
              done(new Error("The update exceeds its published size."))
              return
            }
            clearTimeout(idle)
            idle = setTimeout(stall, downloadIdleTimeoutMs)
            hash.update(chunk)
            const now = Date.now()
            if (now - lastNotification >= progressNotificationIntervalMs) {
              progress(downloaded)
              lastNotification = now
            }
            done(null, chunk)
          },
        }),
        createWriteStream(archivePath, { flags: "wx" }),
        { signal: controller.signal },
      )
      clearTimeout(idle)
      if (
        downloaded !== available.archive.size ||
        hash.digest("hex") !== available.archive.sha256
      )
        throw new Error(
          "The downloaded update failed its integrity check. Try again.",
        )
      progress(downloaded)
      this.publish({
        phase: "preparing",
        current: this.options.current,
        release: available.release,
      })
      const prepared = await prepareDesktopUpdate({
        archivePath,
        stageDirectory: path.join(directory, "prepared"),
        installedAppPath: this.options.applicationPath,
        expectedBuild: available.build,
      })
      if (this.disposed) {
        await removeUpdateDirectory(directory)
        return
      }
      await rm(archivePath)
      this.prepared = { directory, appPath: prepared.appPath }
      this.publish({
        phase: "ready",
        current: this.options.current,
        release: available.release,
      })
    } catch (error) {
      if (directory !== undefined) await removeUpdateDirectory(directory)
      if (!this.disposed) this.fail(error, "download")
    } finally {
      clearTimeout(idle)
      this.activeAbort = undefined
    }
  }

  install(): Promise<void> {
    if (this.disposed || this.installerOwnsStage) return Promise.resolve()
    if (this.operation !== undefined) return this.operation
    const prepared = this.prepared
    const available = this.available
    if (prepared === undefined || available === undefined)
      return Promise.reject(new Error("The update is not ready to install."))
    this.operation = (async () => {
      this.publish({
        phase: "installing",
        current: this.options.current,
        release: available.release,
      })
      try {
        await this.options.install(prepared)
        this.installerOwnsStage = true
      } catch (error) {
        this.fail(error, "install")
      }
    })().finally(() => {
      this.operation = undefined
    })
    return this.operation
  }

  async waitForInstaller(): Promise<void> {
    if (this.state.phase === "installing") await this.operation
  }

  cancelInstallation(): void {
    if (this.prepared === undefined || this.available === undefined) return
    this.installerOwnsStage = false
    this.publish({
      phase: "ready",
      current: this.options.current,
      release: this.available.release,
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.activeAbort?.abort()
    await this.operation
    if (this.prepared !== undefined && !this.installerOwnsStage)
      await removeUpdateDirectory(this.prepared.directory)
  }
}
