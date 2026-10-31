import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import { BrowserPageFocus } from "./browser-focus.ts"
import type { BrowserPoint } from "./browser-pointer.ts"
import type { BrowserDocumentScope } from "./browser-protocol.ts"

type DragCommand = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  confirmed?: (result: unknown) => void,
) => Promise<unknown>

// This fixed hook observes the final dragstart cancellation state after the
// mouse task. It never fabricates DOM events or reads page drag data itself.
function watchDrag(this: Element) {
  let started: DragEvent | undefined
  let moved: Promise<void> = Promise.resolve()
  const drag = (event: DragEvent) => {
    started = event
  }
  const move = () => {
    moved = new Promise((resolve) => setTimeout(resolve, 0))
  }
  window.addEventListener("dragstart", drag, { capture: true })
  window.addEventListener("mousemove", move, { capture: true })
  return {
    async finish() {
      await moved
      return started !== undefined && !started.defaultPrevented
    },
    cleanup() {
      window.removeEventListener("dragstart", drag, { capture: true })
      window.removeEventListener("mousemove", move, { capture: true })
    },
  }
}

type DragData = {
  items: { mimeType: string; data: string; title?: string; baseURL?: string }[]
  dragOperationsMask: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dragData(value: unknown): DragData {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 64 ||
    (value.files !== undefined &&
      (!Array.isArray(value.files) || value.files.length !== 0)) ||
    typeof value.dragOperationsMask !== "number" ||
    !Number.isSafeInteger(value.dragOperationsMask) ||
    // Chromium uses signed -1 for all permitted native drag operations.
    value.dragOperationsMask < -1 ||
    value.dragOperationsMask > 65535 ||
    value.items.some(
      (item) =>
        !record(item) ||
        typeof item.mimeType !== "string" ||
        typeof item.data !== "string" ||
        (item.title !== undefined && typeof item.title !== "string") ||
        (item.baseURL !== undefined && typeof item.baseURL !== "string") ||
        [item.mimeType, item.data, item.title, item.baseURL].some(
          (part) => typeof part === "string" && part.length > 64 * 1024,
        ),
    ) ||
    Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
  )
    throw new BrowserControlError(
      "browser_drag_unavailable",
      "Native drag data contains files or exceeds the 64-item/64KiB transfer safety boundary. Use the explicit upload tool for local files.",
    )
  return {
    items: value.items.map((item: DragData["items"][number]) => ({
      mimeType: item.mimeType,
      data: item.data,
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.baseURL === undefined ? {} : { baseURL: item.baseURL }),
    })),
    dragOperationsMask: value.dragOperationsMask,
  }
}

type DragBinding = {
  scope: BrowserDocumentScope
  command: DragCommand
  installed: boolean
  ticket?: string
  context?: string
  contextGone: boolean
  interception: boolean
  nativeActive: boolean
  data?: DragData
  captured: ReturnType<typeof Promise.withResolvers<unknown>>
}

export class BrowserDrag {
  readonly #focus = new BrowserPageFocus()
  readonly #debug: WebContents["debugger"]
  #binding: DragBinding | undefined
  readonly #contexts = new Map<
    string,
    { frameId: string; sessionId: string | undefined; uniqueId: string }
  >()
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
    if (!record(params)) return
    const binding = this.#binding,
      session = sessionId || undefined
    if (method === "Input.dragIntercepted" && session === undefined) {
      if (binding?.interception) binding.captured.resolve(params.data)
      return
    }
    if (
      method === "Runtime.executionContextCreated" &&
      record(params.context) &&
      params.context.name === "yakitori-browser-input" &&
      record(params.context.auxData) &&
      typeof params.context.auxData.frameId === "string" &&
      typeof params.context.uniqueId === "string"
    ) {
      const frameId = params.context.auxData.frameId
      this.#contexts.set(JSON.stringify([session, frameId]), {
        frameId,
        sessionId: session,
        uniqueId: params.context.uniqueId,
      })
    } else if (
      method === "Runtime.executionContextDestroyed" ||
      method === "Runtime.executionContextsCleared"
    ) {
      for (const [key, context] of this.#contexts) {
        if (
          context.sessionId === session &&
          (method === "Runtime.executionContextsCleared" ||
            context.uniqueId === params.executionContextUniqueId)
        )
          this.#contexts.delete(key)
      }
      if (
        binding &&
        session === binding.scope.frame?.sessionId &&
        (method === "Runtime.executionContextsCleared" ||
          (binding.context !== undefined &&
            params.executionContextUniqueId === binding.context))
      )
        binding.contextGone = true
    }
  }

  constructor(debug: WebContents["debugger"]) {
    this.#debug = debug
    debug.on("message", this.#message)
  }

  get active(): boolean {
    return this.#binding !== undefined || this.#focus.active
  }

  async arm(
    scope: BrowserDocumentScope,
    objectId: string,
    group: string,
    command: DragCommand,
  ): Promise<void> {
    if (this.#binding) throw new Error("A browser drag is already owned.")
    const binding: DragBinding = {
      scope,
      command,
      installed: false,
      contextGone: false,
      interception: false,
      nativeActive: false,
      captured: Promise.withResolvers<unknown>(),
    }
    this.#binding = binding
    await command("Runtime.enable", {}, scope.frame?.sessionId)
    const context = this.#contexts.get(
      JSON.stringify([scope.frame?.sessionId, scope.document.frameId]),
    )?.uniqueId
    if (context) binding.context = context
    scope.closed.throwIfAborted()
    if (!binding.context || binding.contextGone)
      throw new BrowserControlError(
        "browser_drag_unavailable",
        "The drag source's isolated document context is unavailable.",
      )
    binding.installed = true
    await command(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: watchDrag.toString(),
        objectGroup: group,
      },
      scope.frame?.sessionId,
      (result) => {
        if (
          record(result) &&
          record(result.result) &&
          typeof result.result.objectId === "string"
        )
          binding.ticket = result.result.objectId
      },
    )
    if (!binding.ticket)
      throw new BrowserControlError(
        "browser_drag_unavailable",
        "The original source document did not install its drag observer.",
      )
    await this.#focus.enable((enabled, confirmed) =>
      command(
        "Emulation.setFocusEmulationEnabled",
        { enabled },
        undefined,
        confirmed,
      ),
    )
    // Record configuration before sending, including a lost or late ACK.
    binding.interception = true
    binding.nativeActive = true
    await command("Input.setInterceptDrags", { enabled: true })
  }

  async start(signal: AbortSignal): Promise<boolean> {
    const binding = this.#binding
    if (!binding?.ticket) throw new Error("No prepared browser drag observer.")
    signal.throwIfAborted()
    if (binding.data) return true
    const response = await binding.command(
      "Runtime.callFunctionOn",
      {
        objectId: binding.ticket,
        functionDeclaration: "function(){return this.finish()}",
        awaitPromise: true,
        returnByValue: true,
      },
      binding.scope.frame?.sessionId,
    )
    if (
      !record(response) ||
      "exceptionDetails" in response ||
      !record(response.result) ||
      typeof response.result.value !== "boolean"
    )
      throw new BrowserControlError(
        "browser_drag_unavailable",
        "The original source document could not confirm its drag event.",
      )
    if (!response.result.value) return false
    const deadline = AbortSignal.any([
      signal,
      binding.scope.closed,
      AbortSignal.timeout(10_000),
    ])
    deadline.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const abort = () => aborted.reject(deadline.reason)
    deadline.addEventListener("abort", abort, { once: true })
    try {
      binding.data = dragData(
        await Promise.race([binding.captured.promise, aborted.promise]),
      )
    } finally {
      deadline.removeEventListener("abort", abort)
    }
    return true
  }

  async transfer(
    point: BrowserPoint,
    signal: AbortSignal,
    verify: () => Promise<void>,
  ): Promise<boolean> {
    if (!(await this.start(signal))) return false
    const binding = this.#binding
    if (!binding?.data) throw new Error("Native drag data is unavailable.")
    const data = binding.data
    signal.throwIfAborted()
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      signal.throwIfAborted()
      // A dragenter/dragover handler can navigate or replace the destination.
      // Never send the next native event into a replacement document.
      await verify()
      signal.throwIfAborted()
      await binding.command(
        "Input.dispatchDragEvent",
        { type, ...point, data },
        undefined,
        type === "drop"
          ? () => {
              binding.nativeActive = false
            }
          : undefined,
      )
    }
    return true
  }

  async settle(destroyed: boolean): Promise<void> {
    const binding = this.#binding
    if (!binding) return
    if (destroyed) {
      this.#binding = undefined
      return
    }
    try {
      if (binding.nativeActive)
        await binding.command(
          "Input.dispatchDragEvent",
          {
            type: "dragCancel",
            x: 0,
            y: 0,
            data: { items: [], dragOperationsMask: 65535 },
          },
          undefined,
          () => {
            binding.nativeActive = false
          },
        )
      if (binding.interception)
        await binding.command(
          "Input.setInterceptDrags",
          { enabled: false },
          undefined,
          () => {
            binding.interception = false
          },
        )
      if (binding.installed && !binding.contextGone) {
        if (!binding.ticket)
          throw new Error("The drag observer has no cleanup receipt.")
        const result = await binding.command(
          "Runtime.callFunctionOn",
          {
            objectId: binding.ticket,
            functionDeclaration: "function(){this.cleanup()}",
            returnByValue: true,
          },
          binding.scope.frame?.sessionId,
          (result) => {
            if (record(result) && !("exceptionDetails" in result))
              binding.installed = false
          },
        )
        if (record(result) && "exceptionDetails" in result)
          throw new Error("The original drag observer rejected cleanup.")
      }
    } catch (cause) {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Native drag cancellation or observer cleanup is unconfirmed. Computer input remains quarantined until cleanup succeeds or the original tab closes.",
        { cause },
      )
    }
  }

  async cleanup(destroyed: boolean): Promise<void> {
    await this.settle(destroyed)
    await this.#focus.cleanup(destroyed)
    this.#binding = undefined
  }

  close(): void {
    if (this.active)
      throw new Error("An owned browser drag still needs cleanup.")
    this.#debug.off("message", this.#message)
    this.#contexts.clear()
  }
}
