import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  BrowserControlError,
  type BrowserInputRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid browser observation data.")
  return value as Record<string, unknown>
}

function documentIdentity(value: unknown) {
  const frame = object(object(object(value).frameTree).frame)
  if (
    typeof frame.id !== "string" ||
    typeof frame.loaderId !== "string" ||
    typeof frame.url !== "string"
  )
    throw new Error("Chromium returned no live document identity.")
  // CDP separates the document URL and its same-document hash fragment.
  return {
    frameId: frame.id,
    documentId: frame.loaderId,
    url:
      frame.url +
      (typeof frame.urlFragment === "string" ? frame.urlFragment : ""),
  }
}

export class BrowserDocumentConnection {
  #closed = false
  #backspaceHeld = false
  #references = new Map<
    string,
    { backendNodeId: number; document: ReturnType<typeof documentIdentity> }
  >()
  readonly #contents: WebContents
  readonly #debug: WebContents["debugger"]
  readonly #detached = () => {
    this.#closed = true
    this.#references.clear()
  }

  constructor(contents: WebContents) {
    this.#contents = contents
    const debug = contents.debugger
    this.#debug = debug
    if (
      contents.isDestroyed() ||
      !/^https?:\/\//.test(contents.getURL()) ||
      contents.isLoadingMainFrame()
    )
      throw new BrowserControlError(
        "browser_unready",
        "Wait for this browser tab to finish loading before observing it.",
      )
    if (debug.isAttached() || contents.isDevToolsOpened())
      throw new BrowserControlError(
        "browser_busy",
        "Another debugger is attached to this tab. Close its DevTools before observing it.",
      )
    try {
      debug.attach("1.3")
    } catch (cause) {
      throw new BrowserControlError(
        "browser_unavailable",
        cause instanceof Error ? cause.message : String(cause),
      )
    }
    debug.on("detach", this.#detached)
  }

  get closed(): boolean {
    return this.#closed || this.#contents.isDestroyed()
  }

  async #releaseInput(): Promise<void> {
    if (!this.#backspaceHeld) return
    const contents = this.#contents
    if (contents.isDestroyed()) {
      this.#backspaceHeld = false
      return
    }
    if (this.closed || !this.#debug.isAttached())
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The debugger disconnected with an unconfirmed held key. Close this browser target before resuming input.",
      )
    try {
      await this.#debug.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      })
      this.#backspaceHeld = false
    } catch (cause) {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The held Backspace key could not be released: " +
          (cause instanceof Error ? cause.message : String(cause)),
      )
    }
  }

  async close(): Promise<void> {
    await this.#releaseInput()
    if (!this.closed && this.#debug.isAttached()) this.#debug.detach()
    this.#closed = true
    this.#references.clear()
    this.#debug.off("detach", this.#detached)
  }

  async observe(signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted()
    this.#references.clear()
    if (this.#backspaceHeld)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-key cleanup before observing again.",
      )
    const contents = this.#contents,
      debug = this.#debug
    if (this.closed || !debug.isAttached())
      throw new BrowserControlError(
        "browser_unavailable",
        "The owned debugger disconnected. Observe the target again.",
      )
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    let rejectAbort: (cause: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = () => {
      // Read-only work can detach, but any outstanding input state must first
      // release successfully. No cancellation path detaches a held key.
      void this.close().then(
        () =>
          rejectAbort(
            new BrowserControlError(
              "browser_cancelled",
              "Browser observation stopped or exceeded its 10-second operation safety deadline.",
            ),
          ),
        rejectAbort,
      )
    }
    deadline.addEventListener("abort", abort, { once: true })
    const command = async (
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (deadline.aborted) {
        abort()
        return aborted
      }
      const pending: Promise<unknown> = debug
        .sendCommand(method, params)
        .catch((cause: unknown) => {
          throw new BrowserControlError(
            "browser_protocol_error",
            cause instanceof Error ? cause.message : String(cause),
          )
        })
      return Promise.race([pending, aborted])
    }
    try {
      if (deadline.aborted) abort()
      const before = documentIdentity(await command("Page.getFrameTree"))
      const tree = object(
        await command("Accessibility.getFullAXTree", {
          frameId: before.frameId,
          depth: 8,
        }),
      )
      if (!Array.isArray(tree.nodes))
        throw new Error("Chromium returned no accessibility nodes.")
      // CDP exposes depth but no node-count limit on its intermediate AX reply.
      // These bounds cover host output/IPC, not Chromium's traversal allocation.
      const nodes: JsonObject[] = []
      const references = new Map<
        string,
        { backendNodeId: number; document: ReturnType<typeof documentIdentity> }
      >()
      const known = new Set(
        tree.nodes.slice(0, 1000).map((value) => object(value).nodeId),
      )
      let bytes = 0,
        truncated = tree.nodes.length > 1000
      const primitive = (
        value: unknown,
        limit = 2048,
      ): string | number | boolean | undefined => {
        if (value === undefined) return
        const scalar = object(value).value
        if (typeof scalar === "string") {
          if (scalar.length > limit) truncated = true
          return scalar.slice(0, limit)
        }
        if (
          typeof scalar === "boolean" ||
          (typeof scalar === "number" && Number.isFinite(scalar))
        )
          return scalar
        return undefined
      }
      for (const rawNode of tree.nodes) {
        const node = object(rawNode)
        if (node.ignored === true) continue
        if (typeof node.nodeId !== "string")
          throw new Error(
            "Chromium returned an invalid accessibility node identity.",
          )
        if (
          Array.isArray(node.childIds) &&
          node.childIds.some((id) => !known.has(id))
        )
          truncated = true
        const state: [string, string | number | boolean][] = []
        if (Array.isArray(node.properties))
          for (const raw of node.properties) {
            const property = object(raw)
            if (typeof property.name !== "string")
              throw new Error(
                "Chromium returned an invalid accessibility property.",
              )
            const value = primitive(property.value)
            if (value !== undefined) state.push([property.name, value])
          }
        const value = primitive(node.value)
        const role = String(primitive(node.role, 512) ?? "")
        const backendNodeId = node.backendDOMNodeId
        const reference =
          typeof backendNodeId === "number" &&
          Number.isSafeInteger(backendNodeId) &&
          backendNodeId > 0 &&
          ["textbox", "searchbox"].includes(role)
            ? `browser_node_${randomUUID()}`
            : undefined
        const entry: JsonObject = {
          nodeId: node.nodeId,
          ...(reference ? { inputReference: reference } : {}),
          role,
          name: String(primitive(node.name) ?? ""),
          ...(typeof node.backendDOMNodeId === "number"
            ? { backendNodeId: node.backendDOMNodeId }
            : {}),
          ...(value !== undefined ? { value } : {}),
          ...(state.length ? { properties: Object.fromEntries(state) } : {}),
        }
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (nodes.length >= 1000 || bytes + size > 256 * 1024) {
          truncated = true
          break
        }
        bytes += size
        nodes.push(entry)
        if (reference && typeof backendNodeId === "number")
          references.set(reference, { backendNodeId, document: before })
      }
      const after = documentIdentity(await command("Page.getFrameTree"))
      if (
        before.frameId !== after.frameId ||
        before.documentId !== after.documentId ||
        before.url !== after.url ||
        contents.isDestroyed() ||
        contents.getURL() !== after.url
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The browser navigated during observation. List and observe the current target again.",
        )
      if (deadline.aborted)
        throw new BrowserControlError(
          "browser_cancelled",
          "Browser observation stopped.",
        )
      this.#references = references
      return {
        document: { ...after, url: after.url.slice(0, 8192) },
        nodes,
        truncated,
        depth: 8,
        urlTruncated: after.url.length > 8192,
      }
    } finally {
      deadline.removeEventListener("abort", abort)
    }
  }

  async inputText(
    input: BrowserInputRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    if (this.#backspaceHeld)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-key cleanup before sending more input.",
      )
    const reference = this.#references.get(input.reference)
    // A mutation consumes the observation, including sibling references. There
    // is no automatic retry after focus, dispatch or an uncertain text receipt.
    this.#references.clear()
    if (!reference || this.closed)
      throw new BrowserControlError(
        "browser_reference_stale",
        "Observe this document again before typing.",
      )
    const contents = this.#contents,
      debug = this.#debug
    const group = `yakitori_${randomUUID()}`
    let dispatched = false,
      result: JsonObject | undefined,
      failure: unknown
    const command = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> => {
      signal.throwIfAborted()
      if (this.closed)
        throw new BrowserControlError(
          "browser_unavailable",
          "The owned debugger disconnected.",
        )
      // Unlike read-only observation, do not race a dispatched command against
      // cancellation or detach. The caller/turn waits for its acknowledgement.
      try {
        return await debug.sendCommand(method, params)
      } catch (cause) {
        throw new BrowserControlError(
          "browser_protocol_error",
          cause instanceof Error ? cause.message : String(cause),
        )
      }
    }
    const verifyDocument = async () => {
      const current = documentIdentity(await command("Page.getFrameTree"))
      if (
        current.frameId !== reference.document.frameId ||
        current.documentId !== reference.document.documentId ||
        current.url !== reference.document.url ||
        contents.getURL() !== current.url
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The observed document navigated. Observe it again.",
        )
      return current
    }
    try {
      await verifyDocument()
      const world = object(
        await command("Page.createIsolatedWorld", {
          frameId: reference.document.frameId,
          worldName: "yakitori-browser-input",
        }),
      )
      if (typeof world.executionContextId !== "number")
        throw new Error("Chromium returned no isolated input context.")
      const resolved = object(
        object(
          await command("DOM.resolveNode", {
            backendNodeId: reference.backendNodeId,
            executionContextId: world.executionContextId,
            objectGroup: group,
          }),
        ).object,
      )
      if (typeof resolved.objectId !== "string")
        throw new BrowserControlError(
          "browser_reference_stale",
          "The observed control no longer exists.",
        )
      await command("DOM.focus", { backendNodeId: reference.backendNodeId })
      // This fixed function runs in an isolated world, with no page-controlled
      // prototype methods or caller-supplied code. It verifies the exact node,
      // including focus redirection and the current text selection.
      const read = async (requireFocus: boolean, selectAll = false) => {
        const response = object(
          await command("Runtime.callFunctionOn", {
            objectId: resolved.objectId,
            returnByValue: true,
            arguments: [{ value: requireFocus }, { value: selectAll }],
            functionDeclaration: `function(requireFocus, selectAll) {
            if (!this.isConnected || (requireFocus && this.getRootNode().activeElement !== this) || this.disabled || this.readOnly) return {ok:false};
            if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)) return {ok:false};
            if (typeof this.selectionStart !== 'number' || typeof this.selectionEnd !== 'number' || this.value.length > 65536) return {ok:false};
            if (selectAll) {
              if (this instanceof HTMLInputElement) HTMLInputElement.prototype.select.call(this);
              else HTMLTextAreaElement.prototype.select.call(this);
            }
            return {ok:true,value:this.value,start:this.selectionStart,end:this.selectionEnd};
          }`,
          }),
        )
        const value = object(object(response.result).value)
        if (
          value.ok !== true ||
          typeof value.value !== "string" ||
          typeof value.start !== "number" ||
          typeof value.end !== "number"
        )
          throw new BrowserControlError(
            "browser_input_unavailable",
            "The exact text control is unavailable, read-only or no longer focused.",
          )
        return { value: value.value, start: value.start, end: value.end }
      }
      const before = await read(true, input.action === "fill")
      await verifyDocument()
      signal.throwIfAborted()
      dispatched = true
      if (input.action === "fill" && input.text === "") {
        if (this.closed)
          throw new BrowserControlError(
            "browser_unavailable",
            "The owned debugger disconnected.",
          )
        this.#backspaceHeld = true
        await command("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        })
        await this.#releaseInput()
      } else await command("Input.insertText", { text: input.text })
      await verifyDocument()
      const after = await read(false)
      const expected =
        before.value.slice(0, before.start) +
        input.text +
        before.value.slice(before.end)
      if (after.value !== expected)
        throw new BrowserControlError(
          "browser_input_unconfirmed",
          "Text was dispatched but the exact control did not confirm the expected value. Do not replay it automatically.",
        )
      result = {
        delivered: true,
        textVerified: true,
        bytes: Buffer.byteLength(input.text),
        valueLength: after.value.length,
      }
    } catch (cause) {
      if (dispatched && cause instanceof BrowserControlError)
        failure = new BrowserControlError(
          "browser_input_unconfirmed",
          "Text dispatch was attempted but its receipt could not be confirmed. Observe again; do not replay automatically. " +
            cause.message,
        )
      else failure = cause
    }
    // Release is independent of cancellation. A failed key-up is surfaced to
    // the shared input gate and remains retryable by finishTurn/closeSession.
    const [inputCleanup, groupCleanup] = await Promise.allSettled([
      this.#releaseInput(),
      this.closed
        ? undefined
        : debug.sendCommand("Runtime.releaseObjectGroup", {
            objectGroup: group,
          }),
    ])
    if (inputCleanup?.status === "rejected") {
      const causes = [
        inputCleanup.reason,
        ...(failure === undefined ? [] : [failure]),
        ...(groupCleanup?.status === "rejected" ? [groupCleanup.reason] : []),
      ]
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Held-key cleanup could not be confirmed.",
        {
          cause: new AggregateError(
            causes,
            "Browser operation and cleanup failed.",
          ),
        },
      )
    }
    if (groupCleanup?.status === "rejected") {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, groupCleanup.reason],
          "Browser operation and object cleanup failed.",
        )
      throw groupCleanup.reason
    }
    if (failure !== undefined) throw failure
    if (!result) throw new Error("Browser input produced no result.")
    return result
  }
}
