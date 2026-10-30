import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type {
  ComputerPreviewCatalog,
  ComputerPreviewFrame,
  ComputerPreviewTarget,
} from "../protocol/computer-preview.ts"
import { computerUseServerName } from "../protocol/connections.ts"
import { McpClient, McpConnectionError } from "../runtime/mcp-client.ts"
import {
  type ComputerUseDiscoveryOptions,
  discoverComputerUse,
} from "./computer-use.ts"
import type { UserConfigStore } from "./user-config.ts"

export class ComputerPreviewError extends Error {}

export type ComputerPreviewOwner = Readonly<{
  connectionId: number
  viewerId: string
}>

function ownerKey(owner: ComputerPreviewOwner): string {
  return `${owner.connectionId}/${owner.viewerId}`
}

type PreviewConnection = {
  connectionId: number
  cancellation: AbortController
  client?: McpClient
  call?: ReturnType<McpClient["bindTool"]>
  busy: boolean
  idle?: ReturnType<typeof setTimeout>
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ComputerPreviewError(
      "The native preview service returned invalid data.",
    )
  return value as Record<string, unknown>
}

function structured(result: CallToolResult): Record<string, unknown> {
  if (result.isError)
    throw new ComputerPreviewError(
      String(result.structuredContent?.message ?? "Native preview failed."),
    )
  return record(result.structuredContent)
}

export class ComputerPreviewService {
  readonly #connections = new Map<string, PreviewConnection>()
  readonly #retiring = new Map<PreviewConnection, Promise<void>>()
  readonly #config: UserConfigStore
  readonly #discovery: ComputerUseDiscoveryOptions
  readonly #report: (cause: unknown) => void
  #closed = false

  constructor(
    config: UserConfigStore,
    report: (cause: unknown) => void,
    discovery: ComputerUseDiscoveryOptions = {},
  ) {
    this.#config = config
    this.#report = report
    this.#discovery = discovery
  }

  async #run<T>(
    owner: ComputerPreviewOwner,
    operation: (
      call: ReturnType<McpClient["bindTool"]>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#closed)
      throw new ComputerPreviewError("Computer preview is shutting down.")
    const key = ownerKey(owner)
    let connection = this.#connections.get(key)
    if (connection?.busy)
      throw new ComputerPreviewError(
        "A preview request is already running for this viewer.",
      )
    if (!connection) {
      // Each helper owns a capture allocation. Count draining connections too,
      // so rapid stop/reopen requests cannot bypass the four-client safety bound.
      if (this.#connections.size + this.#retiring.size >= 4)
        throw new ComputerPreviewError(
          "Too many live previews are open. Stop another preview first.",
        )
      connection = {
        connectionId: owner.connectionId,
        cancellation: new AbortController(),
        busy: false,
      }
      this.#connections.set(key, connection)
    }
    connection.busy = true
    clearTimeout(connection.idle)
    const current = connection
    try {
      const configured = (await this.#config.readConfiguration()).mcpServers?.[
        computerUseServerName
      ]
      const installed = await discoverComputerUse(this.#discovery)
      if (
        !configured ||
        configured.enabled === false ||
        configured.disabledTools?.includes("control") ||
        (configured.enabledTools !== undefined &&
          !configured.enabledTools.includes("control"))
      )
        throw new ComputerPreviewError(
          "Connect computer use before starting a preview.",
        )
      if (
        !installed ||
        !("command" in configured) ||
        configured.command !== installed.command
      )
        throw new ComputerPreviewError(
          "Isolated preview requires the bundled native computer helper.",
        )
      current.cancellation.signal.throwIfAborted()
      if (!current.client) {
        const client = new McpClient(
          computerUseServerName,
          installed,
          () => {},
          () => {},
          () => {},
        )
        current.client = client
        const tools = await client.start(current.cancellation.signal)
        const control = tools.find((tool) => tool.name === "control")
        if (!control)
          throw new McpConnectionError(
            "The native preview control tool is unavailable.",
          )
        current.call = client.bindTool(control)
      }
      if (!current.call)
        throw new Error(
          "Preview connection initialized without a control binding.",
        )
      return await operation(current.call, current.cancellation.signal)
    } catch (cause) {
      const cancelled = current.cancellation.signal.aborted
      await this.#retire(key, current)
      if (cancelled) throw new ComputerPreviewError("Computer preview stopped.")
      throw cause
    } finally {
      current.busy = false
      if (this.#connections.get(key) === current) {
        // A hidden/crashed renderer must not leave a capture helper resident.
        current.idle = setTimeout(() => {
          void this.#retire(key, current).catch(this.#report)
        }, 10_000)
        current.idle.unref()
      }
    }
  }

  async catalog(owner: ComputerPreviewOwner): Promise<ComputerPreviewCatalog> {
    return this.#run(owner, async (call, signal) => {
      const data = structured(await call({ action: "list" }, signal))
      if (
        !Array.isArray(data.apps) ||
        !Array.isArray(data.windows) ||
        !Array.isArray(data.displays)
      )
        throw new ComputerPreviewError(
          "The native preview catalog is incomplete.",
        )
      const names = new Map(
        data.apps.map((value) => {
          const app = record(value)
          return [
            app.pid,
            typeof app.name === "string" ? app.name : "App",
          ] as const
        }),
      )
      const targets: ComputerPreviewCatalog["targets"][number][] = []
      const seenApps = new Set<number>()
      for (const value of data.displays) {
        const display = record(value)
        if (
          typeof display.display_id !== "number" ||
          !Number.isSafeInteger(display.display_id) ||
          display.display_id <= 0
        )
          throw new ComputerPreviewError(
            "The native display identity is invalid.",
          )
        targets.push({
          id: `screen:${display.display_id}`,
          label: `Display ${display.display_id}${display.main === true ? " · main" : ""}`,
          target: { scope: "screen", displayId: display.display_id },
        })
      }
      for (const value of data.windows) {
        const window = record(value)
        if (
          typeof window.pid !== "number" ||
          !Number.isSafeInteger(window.pid) ||
          window.pid <= 0 ||
          typeof window.window_id !== "number" ||
          !Number.isSafeInteger(window.window_id) ||
          window.window_id <= 0
        )
          throw new ComputerPreviewError(
            "The native window identity is invalid.",
          )
        if (
          typeof window.launch_time !== "number" ||
          !Number.isFinite(window.launch_time) ||
          window.launch_time <= 0
        )
          continue
        const name = names.get(window.pid) ?? `App ${window.pid}`
        if (!seenApps.has(window.pid)) {
          seenApps.add(window.pid)
          targets.push({
            id: `app:${window.pid}:${window.launch_time}`,
            label: `${name} · all windows`,
            target: {
              scope: "app",
              pid: window.pid,
              launchTime: window.launch_time,
            },
          })
        }
        const title =
          typeof window.title === "string" && window.title.length > 0
            ? window.title
            : `Window ${window.window_id}`
        targets.push({
          id: `window:${window.pid}:${window.launch_time}:${window.window_id}`,
          label: `${name} · ${title}`,
          target: {
            scope: "window",
            pid: window.pid,
            launchTime: window.launch_time,
            windowId: window.window_id,
          },
        })
      }
      return { targets }
    })
  }

  async capture(
    owner: ComputerPreviewOwner,
    target: ComputerPreviewTarget,
  ): Promise<ComputerPreviewFrame> {
    return this.#run(owner, async (call, signal) => {
      const result = await call(
        {
          action: "preview",
          mode: "vision",
          scope: target.scope,
          ...(target.scope === "screen"
            ? { display_id: target.displayId }
            : { pid: target.pid, launch_time: target.launchTime }),
          ...(target.scope === "window" ? { window_id: target.windowId } : {}),
        },
        signal,
      )
      const data = structured(result)
      const image = result.content.find((part) => part.type === "image")
      const frame = record(data.frame)
      if (
        data.input_available !== false ||
        typeof data.preview_id !== "string" ||
        !data.preview_id.startsWith("preview_") ||
        data.snapshot_id !== undefined ||
        typeof data.geometry_stable !== "boolean" ||
        image?.type !== "image" ||
        image.mimeType !== "image/png" ||
        image.data.length > 8 * 1024 * 1024 ||
        ![data.image_width, data.image_height].every(
          (value) =>
            typeof value === "number" &&
            Number.isInteger(value) &&
            value > 0 &&
            value <= 1024,
        ) ||
        ![frame.x, frame.y, frame.width, frame.height].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) ||
        Number(frame.width) <= 0 ||
        Number(frame.height) <= 0
      )
        throw new ComputerPreviewError(
          "The native preview image or geometry is invalid.",
        )
      const header = Buffer.from(image.data.slice(0, 44), "base64")
      if (
        header.length < 24 ||
        !header
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        header.readUInt32BE(16) !== data.image_width ||
        header.readUInt32BE(20) !== data.image_height
      )
        throw new ComputerPreviewError(
          "The native preview PNG does not match its geometry.",
        )
      if (
        target.scope !== "screen" &&
        (!Array.isArray(data.windows) ||
          data.windows.length === 0 ||
          !data.windows.every((value) => {
            const window = record(value)
            return (
              window.pid === target.pid &&
              window.launch_time === target.launchTime &&
              (target.scope !== "window" ||
                window.window_id === target.windowId)
            )
          }))
      )
        throw new ComputerPreviewError(
          "The preview process incarnation changed; refresh the target list.",
        )
      const status = data.geometry_stable
        ? structured(await call({ action: "status" }, signal))
        : {}
      const pointer =
        status.pointer === null || status.pointer === undefined
          ? undefined
          : record(status.pointer)
      return {
        dataUrl: `data:image/png;base64,${image.data}`,
        width: Number(data.image_width),
        height: Number(data.image_height),
        frame: {
          x: Number(frame.x),
          y: Number(frame.y),
          width: Number(frame.width),
          height: Number(frame.height),
        },
        ...(pointer &&
        typeof pointer.x === "number" &&
        Number.isFinite(pointer.x) &&
        typeof pointer.y === "number" &&
        Number.isFinite(pointer.y)
          ? { pointer: { x: pointer.x, y: pointer.y } }
          : {}),
        receivedAt: new Date().toISOString(),
      }
    })
  }

  async #retire(key: string, current: PreviewConnection): Promise<void> {
    const pending = this.#retiring.get(current)
    if (pending) return pending
    if (this.#connections.get(key) === current) this.#connections.delete(key)
    clearTimeout(current.idle)
    current.cancellation.abort()
    const closing = current.client?.close() ?? Promise.resolve()
    this.#retiring.set(current, closing)
    try {
      await closing
    } finally {
      this.#retiring.delete(current)
    }
  }

  async stop(owner: ComputerPreviewOwner): Promise<void> {
    const key = ownerKey(owner)
    const current = this.#connections.get(key)
    if (current) await this.#retire(key, current)
  }

  async stopConnection(connectionId: number): Promise<void> {
    await Promise.all([
      ...[...this.#connections]
        .filter(([, current]) => current.connectionId === connectionId)
        .map(([key, current]) => this.#retire(key, current)),
      ...[...this.#retiring]
        .filter(([current]) => current.connectionId === connectionId)
        .map(([, closing]) => closing),
    ])
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      ...[...this.#connections].map(([key, current]) =>
        this.#retire(key, current),
      ),
      ...this.#retiring.values(),
    ])
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.stopAll()
  }
}
