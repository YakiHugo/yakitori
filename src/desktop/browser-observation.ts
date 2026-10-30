import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  type BrowserCaptureRequest,
  BrowserControlError,
  type BrowserDirectoryUploadRequest,
  type BrowserKeyRequest,
  type BrowserPointerRequest,
  type BrowserSelectRequest,
  type BrowserTextInputRequest,
  type BrowserUploadRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import {
  type BrowserControlReference,
  browserAccessibility,
  documentIdentity,
} from "./browser-accessibility.ts"
import { captureBrowserPage } from "./browser-capture.ts"
import { setBrowserDirectory } from "./browser-directory.ts"
import { clearBrowserFiles, inspectBrowserFiles } from "./browser-files.ts"
import { BrowserFrames } from "./browser-frames.ts"
import { browserKeyStroke } from "./browser-key.ts"
import { BrowserPendingMutations } from "./browser-mutations.ts"
import {
  BrowserFramePointer,
  browserPointerGeometry,
} from "./browser-pointer.ts"
import {
  type BrowserFrameReadMethod,
  type BrowserProtocolCommand,
  isBrowserFrameReadMethod,
} from "./browser-protocol.ts"
import {
  selectBrowserOptions,
  verifyBrowserSelection,
} from "./browser-select.ts"
import { BrowserFrameSessions } from "./browser-sessions.ts"

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid browser observation data.")
  return value as Record<string, unknown>
}

export class BrowserDocumentConnection {
  #closed = false
  readonly #lifetime = new AbortController()
  #releasingInput: Promise<void> | undefined
  #heldInputs: Readonly<{
    method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent"
    params: Record<string, unknown>
  }>[] = []
  #references = new Map<string, BrowserControlReference>()
  readonly #contents: WebContents
  readonly #debug: WebContents["debugger"]
  readonly #sessions: BrowserFrameSessions
  readonly #frameCatalog: BrowserFrames
  readonly #mutations: BrowserPendingMutations
  readonly #directoryReady: (signal: AbortSignal) => Promise<void>
  readonly #detached = () => {
    this.#closed = true
    this.#lifetime.abort(
      new BrowserControlError(
        "browser_unavailable",
        "The owned debugger disconnected.",
      ),
    )
    this.#references.clear()
    this.#frameCatalog.close()
    this.#sessions.close()
  }

  constructor(
    contents: WebContents,
    directoryReady: (signal: AbortSignal) => Promise<void> = async (signal) => {
      signal.throwIfAborted()
    },
  ) {
    this.#contents = contents
    this.#directoryReady = directoryReady
    this.#mutations = new BrowserPendingMutations(() => contents.isDestroyed())
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
    this.#sessions = new BrowserFrameSessions(debug)
    this.#frameCatalog = new BrowserFrames(this.#sessions)
    debug.on("detach", this.#detached)
  }

  get closed(): boolean {
    return this.#closed || this.#contents.isDestroyed()
  }

  assertInputIdle(): void {
    this.#mutations.assertCompleted()
    if (this.#heldInputs.length)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-input cleanup before changing the browser view or sending more input.",
      )
  }

  async #releaseInput(): Promise<void> {
    if (this.#releasingInput) return this.#releasingInput
    // Read cancellation and turn cleanup can request release concurrently.
    // Install the shared promise before dispatching any owned key/button-up.
    const release = Promise.resolve().then(async () => {
      this.#mutations.assertCompleted()
      while (this.#heldInputs.length) {
        const held = this.#heldInputs.at(-1)
        if (!held) throw new Error("Missing owned held input.")
        const contents = this.#contents
        if (contents.isDestroyed()) {
          this.#heldInputs.length = 0
          return
        }
        if (this.closed || !this.#debug.isAttached())
          throw new BrowserControlError(
            "browser_cleanup_failed",
            "The debugger disconnected with an unconfirmed held input. Close this browser target before resuming input.",
          )
        try {
          await this.#debug.sendCommand(held.method, held.params)
          this.#heldInputs.pop()
        } catch (cause) {
          throw new BrowserControlError(
            "browser_cleanup_failed",
            "The held browser input could not be released: " +
              (cause instanceof Error ? cause.message : String(cause)),
          )
        }
      }
    })
    this.#releasingInput = release
    try {
      await release
    } finally {
      if (this.#releasingInput === release) this.#releasingInput = undefined
    }
  }

  async close(): Promise<void> {
    this.#mutations.assertCompleted()
    await this.#releaseInput()
    if (!this.closed && this.#debug.isAttached()) this.#debug.detach()
    this.#closed = true
    this.#lifetime.abort(
      new BrowserControlError(
        "browser_unavailable",
        "The owned browser connection closed.",
      ),
    )
    this.#references.clear()
    this.#debug.off("detach", this.#detached)
    this.#frameCatalog.close()
    this.#sessions.close()
  }

  async #read<T>(
    signal: AbortSignal,
    run: (command: BrowserProtocolCommand) => Promise<T>,
    duringInput = false,
  ): Promise<T> {
    signal.throwIfAborted()
    this.#mutations.assertCompleted()
    if (this.#heldInputs.length && !duringInput)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-input cleanup before observing again.",
      )
    const debug = this.#debug
    if (this.closed || !debug.isAttached())
      throw new BrowserControlError(
        "browser_unavailable",
        "The owned debugger disconnected. Observe the target again.",
      )
    const deadline = AbortSignal.any([
      signal,
      this.#lifetime.signal,
      AbortSignal.timeout(10_000),
    ])
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
              "Browser read stopped or exceeded its 10-second operation safety deadline.",
            ),
          ),
        rejectAbort,
      )
    }
    deadline.addEventListener("abort", abort, { once: true })
    const command = async (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) => {
      if (deadline.aborted) {
        abort()
        return aborted
      }
      const send: BrowserProtocolCommand = (name, args, session) =>
        debug.sendCommand(name, args, session)
      const pending: Promise<unknown> = (
        sessionId !== undefined && isBrowserFrameReadMethod(method)
          ? this.#sessions.readInSession(send, method, params, sessionId)
          : send(method, params, sessionId)
      )
        .then((value) => (deadline.aborted ? aborted : value))
        .catch((cause: unknown) => {
          if (deadline.aborted) return aborted
          if (cause instanceof BrowserControlError) throw cause
          throw new BrowserControlError(
            "browser_protocol_error",
            cause instanceof Error ? cause.message : String(cause),
          )
        })
      return Promise.race([pending, aborted])
    }
    try {
      if (deadline.aborted) abort()
      return await Promise.race([run(command), aborted])
    } finally {
      deadline.removeEventListener("abort", abort)
    }
  }

  #inputReadCommand(
    method: BrowserFrameReadMethod,
    params: Record<string, unknown>,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<unknown> {
    // Input reads may run between acknowledged modifier presses. Cancellation
    // first releases those inputs and closes the owned debugger; mutations
    // continue to await their protocol acknowledgement in #inputCommand.
    return this.#read(
      signal,
      (command) => command(method, params, sessionId),
      true,
    )
  }

  async frames(offset: number, signal: AbortSignal): Promise<JsonObject> {
    this.#references.clear()
    return this.#read(signal, async (command) => {
      const { result, root } = await this.#frameCatalog.list(command, offset)
      if (this.#contents.isDestroyed() || this.#contents.getURL() !== root.url)
        throw new BrowserControlError(
          "browser_target_changed",
          "The main document changed while listing frames.",
        )
      return result
    })
  }

  async observe(
    signal: AbortSignal,
    frameReference?: string,
  ): Promise<JsonObject> {
    this.#references.clear()
    const contents = this.#contents
    return this.#read(signal, async (command) => {
      const selected = frameReference
        ? await this.#frameCatalog.resolve(frameReference, command)
        : undefined
      const before =
        selected?.frame.document ??
        documentIdentity(await command("Page.getFrameTree"))
      const root = selected?.root ?? before
      const { nodes, references, truncated } = browserAccessibility(
        await command(
          "Accessibility.getFullAXTree",
          { frameId: before.frameId, depth: 8 },
          selected?.frame.sessionId,
        ),
        before,
      )
      const after = frameReference
        ? (await this.#frameCatalog.resolve(frameReference, command)).frame
            .document
        : documentIdentity(await command("Page.getFrameTree"))
      if (
        before.frameId !== after.frameId ||
        before.documentId !== after.documentId ||
        before.url !== after.url ||
        contents.isDestroyed() ||
        contents.getURL() !== root.url
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The browser navigated during observation. List and observe the current target again.",
        )
      signal.throwIfAborted()
      if (selected && before.frameId !== root.frameId && frameReference) {
        const frame = {
          reference: frameReference,
          ...(selected.frame.sessionId
            ? { sessionId: selected.frame.sessionId }
            : {}),
        }
        for (const [token, reference] of references)
          references.set(token, { ...reference, frame })
      }
      this.#references = references
      return {
        document: { ...after, url: after.url.slice(0, 8192) },
        ...(frameReference
          ? {
              frameReference,
              mainDocument: { ...root, url: root.url.slice(0, 8192) },
            }
          : {}),
        nodes,
        truncated,
        depth: 8,
        urlTruncated: after.url.length > 8192,
      }
    })
  }

  async capture(
    input: BrowserCaptureRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const contents = this.#contents
    if (contents.isLoadingMainFrame())
      throw new BrowserControlError(
        "browser_unready",
        "Wait for this document to finish loading before capturing it.",
      )
    return this.#read(signal, async (command) => {
      const before = documentIdentity(await command("Page.getFrameTree"))
      if (contents.isDestroyed())
        throw new BrowserControlError(
          "browser_unavailable",
          "The browser target closed during capture.",
        )
      const zoom = contents.getZoomFactor()
      const image = await captureBrowserPage(input, command, zoom)
      const after = documentIdentity(await command("Page.getFrameTree"))
      if (
        before.frameId !== after.frameId ||
        before.documentId !== after.documentId ||
        before.url !== after.url ||
        contents.isDestroyed() ||
        contents.getURL() !== after.url ||
        contents.getZoomFactor() !== zoom
      )
        throw new BrowserControlError(
          "browser_target_changed",
          "The browser document or zoom changed during capture. Inspect the current document before capturing again.",
        )
      return {
        ...image,
        document: { ...after, url: after.url.slice(0, 8192) },
        urlTruncated: after.url.length > 8192,
      }
    })
  }

  #consumeReference(
    token: string,
    kind: BrowserControlReference["kind"],
  ): BrowserControlReference {
    this.assertInputIdle()
    const reference = this.#references.get(token)
    this.#references.clear()
    if (!reference || reference.kind !== kind || this.closed)
      throw new BrowserControlError(
        "browser_reference_stale",
        "Observe this document again before typing or clicking.",
      )
    return reference
  }

  #mutationLifetime(sessionId?: string): AbortSignal {
    return sessionId === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([
          this.#lifetime.signal,
          this.#sessions.sessionClosed(sessionId),
        ])
  }

  async #inputCommand(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (this.closed)
      throw new BrowserControlError(
        "browser_unavailable",
        "The owned debugger disconnected.",
      )
    // DOM/Runtime commands can target a frame session. Browser input belongs
    // to the root page's focused widget, even for out-of-process iframes.
    // That release channel survives child renderer navigation.
    if (sessionId !== undefined && method.startsWith("Input."))
      throw new Error("Browser input must use the owned root session.")
    // Ordinary cancellation still waits for acknowledgement. A lost original
    // session can report promptly, but unconfirmed mutations prevent cleanup.
    const closed = this.#mutationLifetime(sessionId)
    try {
      return await this.#mutations.run(
        () => this.#debug.sendCommand(method, params, sessionId),
        closed,
      )
    } catch (cause) {
      if (cause instanceof BrowserControlError) throw cause
      throw new BrowserControlError(
        "browser_protocol_error",
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }

  async #verifyDocument(
    reference: BrowserControlReference,
    signal: AbortSignal,
  ) {
    const frame = reference.frame
      ? await this.#frameCatalog.resolve(
          reference.frame.reference,
          (method, params = {}, sessionId) => {
            if (method === "Page.getFrameTree")
              return this.#inputReadCommand(method, params, signal, sessionId)
            if (method === "Target.setAutoAttach")
              return this.#read(
                signal,
                (command) => command(method, params, sessionId),
                true,
              )
            throw new Error(`Unexpected frame catalog command ${method}`)
          },
        )
      : undefined
    const expected = reference.document
    const current =
      frame?.frame.document ??
      documentIdentity(
        await this.#inputReadCommand("Page.getFrameTree", {}, signal),
      )
    if (
      current.frameId !== expected.frameId ||
      current.documentId !== expected.documentId ||
      current.url !== expected.url ||
      this.#contents.isDestroyed() ||
      this.#contents.getURL() !== (frame?.root.url ?? current.url) ||
      (frame !== undefined &&
        frame.frame.sessionId !== reference.frame?.sessionId)
    )
      throw new BrowserControlError(
        "browser_target_changed",
        "The observed document navigated. Observe it again.",
      )
    return frame
  }

  async #documentChanged(
    reference: BrowserControlReference,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.#verifyDocument(reference, signal)
      return false
    } catch (cause) {
      if (
        cause instanceof BrowserControlError &&
        ["browser_target_changed", "browser_frame_stale"].includes(cause.code)
      )
        return true
      throw cause
    }
  }

  async #resolveReference(
    reference: BrowserControlReference,
    group: string,
    signal: AbortSignal,
  ): Promise<string> {
    await this.#verifyDocument(reference, signal)
    const world = object(
      await this.#inputReadCommand(
        "Page.createIsolatedWorld",
        {
          frameId: reference.document.frameId,
          worldName: "yakitori-browser-input",
        },
        signal,
        reference.frame?.sessionId,
      ),
    )
    if (typeof world.executionContextId !== "number")
      throw new Error("Chromium returned no isolated input context.")
    const resolved = object(
      object(
        await this.#inputReadCommand(
          "DOM.resolveNode",
          {
            backendNodeId: reference.backendNodeId,
            executionContextId: world.executionContextId,
            objectGroup: group,
          },
          signal,
          reference.frame?.sessionId,
        ),
      ).object,
    )
    if (typeof resolved.objectId !== "string")
      throw new BrowserControlError(
        "browser_reference_stale",
        "The observed control no longer exists.",
      )
    return resolved.objectId
  }

  async #finishInput(
    group: string,
    failure: unknown,
    sessionId?: string,
    additionalSessions: Iterable<string | undefined> = [],
  ): Promise<void> {
    // Never send a key/button-up or detach while its down (or another owned
    // mutation) can still complete later. Cleanup remains retryable on late ack.
    this.#mutations.assertCompleted()
    // Release is independent of cancellation. A failed key-up is surfaced to
    // the shared input gate and remains retryable by finishTurn/closeSession.
    const [inputCleanup, ...groupsCleanup] = await Promise.allSettled([
      this.#releaseInput(),
      ...[...new Set([sessionId, ...additionalSessions])].map((id) =>
        this.closed
          ? undefined
          : this.#sessions.releaseObjects(
              group,
              (method, params, session) =>
                this.#debug.sendCommand(method, params, session),
              id,
            ),
      ),
    ])
    const groupFailures = groupsCleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    )
    if (inputCleanup?.status === "rejected") {
      const causes = [
        inputCleanup.reason,
        ...(failure === undefined ? [] : [failure]),
        ...groupFailures,
      ]
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Held-input cleanup could not be confirmed. Close this browser target before resuming input.",
        {
          cause: new AggregateError(
            causes,
            "Browser operation and cleanup failed.",
          ),
        },
      )
    }
    // Remote object groups disappear with their protocol session. This does
    // not prove input release; the held-input failure above still wins.
    if (groupFailures.length && !this.closed) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, ...groupFailures],
          "Browser operation and object cleanup failed.",
        )
      if (groupFailures.length === 1) throw groupFailures[0]
      throw new AggregateError(groupFailures, "Browser object cleanup failed.")
    }
    if (failure !== undefined) throw failure
  }

  async inputText(
    input: BrowserTextInputRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "text")
    const group = `yakitori_${randomUUID()}`
    let dispatched = false,
      result: JsonObject | undefined,
      failure: unknown
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal, reference.frame?.sessionId)
    const verifyDocument = () => this.#verifyDocument(reference, signal)
    try {
      const objectId = await this.#resolveReference(reference, group, signal)
      await command("DOM.focus", { backendNodeId: reference.backendNodeId })
      // This fixed function runs in an isolated world, with no page-controlled
      // prototype methods or caller-supplied code. It verifies the exact node,
      // including focus redirection and the current text selection.
      const read = async (requireFocus: boolean, selectAll = false) => {
        const params = {
          objectId,
          returnByValue: true,
          arguments: [{ value: requireFocus }, { value: selectAll }],
          functionDeclaration: `function(requireFocus, selectAll) {
            if (!this.isConnected || this.ownerDocument !== document || (requireFocus && this.getRootNode().activeElement !== this) || this.disabled || this.readOnly) return {ok:false};
            if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)) return {ok:false};
            if (typeof this.selectionStart !== 'number' || typeof this.selectionEnd !== 'number' || this.value.length > 65536) return {ok:false};
            if (selectAll) {
              if (this instanceof HTMLInputElement) HTMLInputElement.prototype.select.call(this);
              else HTMLTextAreaElement.prototype.select.call(this);
            }
            return {ok:true,value:this.value,start:this.selectionStart,end:this.selectionEnd};
          }`,
        }
        const response = object(
          await (selectAll
            ? command("Runtime.callFunctionOn", params)
            : this.#inputReadCommand(
                "Runtime.callFunctionOn",
                params,
                signal,
                reference.frame?.sessionId,
              )),
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
        this.#heldInputs.push({
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          },
        })
        await this.#inputCommand(
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          },
          signal,
        )
        await this.#releaseInput()
      } else
        await this.#inputCommand(
          "Input.insertText",
          { text: input.text },
          signal,
        )
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
    await this.#finishInput(group, failure, reference.frame?.sessionId)
    if (!result) throw new Error("Browser input produced no result.")
    return result
  }

  async uploadFiles(
    input: BrowserUploadRequest | BrowserDirectoryUploadRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "element"),
      group = `yakitori_${randomUUID()}`
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal, reference.frame?.sessionId)
    let attempted = false,
      result: JsonObject | undefined,
      failure: unknown
    try {
      if (reference.document.url !== input.fromUrl)
        throw new BrowserControlError(
          "browser_target_changed",
          "The selected document URL does not match the upload approval. Observe again.",
        )
      const objectId = await this.#resolveReference(reference, group, signal)
      const inspect = async (readFiles: boolean) => {
        const reply = object(
          await this.#inputReadCommand(
            "Runtime.callFunctionOn",
            {
              objectId,
              returnByValue: true,
              functionDeclaration: inspectBrowserFiles.toString(),
              arguments: [{ value: readFiles }],
            },
            signal,
            reference.frame?.sessionId,
          ),
        )
        const state = object(object(reply.result).value)
        if (state.ok !== true)
          throw new BrowserControlError(
            "browser_input_unavailable",
            typeof state.reason === "string"
              ? state.reason
              : "The exact file input is unavailable.",
          )
        return state
      }
      const before = await inspect(false)
      if (
        typeof before.multiple !== "boolean" ||
        typeof before.directory !== "boolean"
      )
        throw new Error("Chromium returned invalid file input capabilities.")
      if (input.action === "upload_directory" && before.directory !== true)
        throw new BrowserControlError(
          "browser_input_unavailable",
          "This file input does not accept a directory.",
        )
      if (
        input.action === "upload" &&
        input.files.length > 1 &&
        before.multiple !== true
      )
        throw new BrowserControlError(
          "browser_input_unavailable",
          "This file input does not accept multiple files.",
        )
      if (
        input.action === "upload" &&
        input.files.length &&
        before.directory === true
      )
        throw new BrowserControlError(
          "browser_input_unavailable",
          "This input requires a directory workflow, not individual file paths.",
        )
      if (input.action === "upload_directory")
        await this.#directoryReady(
          AbortSignal.any([
            signal,
            this.#mutationLifetime(reference.frame?.sessionId),
          ]),
        )
      await this.#verifyDocument(reference, signal)
      attempted = true
      if (input.action === "upload_directory") {
        signal.throwIfAborted()
        const sessionId = reference.frame?.sessionId
        const applied = await this.#mutations.run(
          () =>
            setBrowserDirectory(
              (method, params) =>
                this.#debug.sendCommand(method, params, sessionId),
              objectId,
              reference.backendNodeId,
              input.directory,
              group,
            ),
          AbortSignal.any([
            this.#mutationLifetime(sessionId),
            AbortSignal.timeout(10_000),
          ]),
          "effect",
        )
        if (applied === false) {
          attempted = false
          throw new BrowserControlError(
            "browser_input_unavailable",
            "The exact directory input changed before selection.",
          )
        }
      } else if (input.files.length)
        await command("DOM.setFileInputFiles", {
          backendNodeId: reference.backendNodeId,
          files: input.files.map((file) => file.path),
        })
      else {
        // Electron 43's CDP files:[] acknowledges without clearing. This is
        // an explicit clear operation, never a retry after uncertain upload.
        const reply = object(
          await command("Runtime.callFunctionOn", {
            objectId,
            returnByValue: true,
            functionDeclaration: clearBrowserFiles.toString(),
          }),
        )
        const cleared = object(object(reply.result).value)
        if (cleared.applied === false) attempted = false
        if (cleared.ok !== true)
          throw new BrowserControlError(
            attempted
              ? "browser_input_unconfirmed"
              : "browser_input_unavailable",
            "The exact file input did not confirm clearing.",
          )
      }
      await this.#verifyDocument(reference, signal)
      const after = await inspect(true)
      if (!Array.isArray(after.files))
        throw new Error("Chromium returned invalid file metadata.")
      const files = after.files.map((value) => {
        const file = object(value)
        if (
          typeof file.name !== "string" ||
          typeof file.size !== "number" ||
          typeof file.lastModified !== "number" ||
          typeof file.relativePath !== "string"
        )
          throw new Error("Chromium returned invalid file metadata fields.")
        return {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          relativePath: file.relativePath,
        }
      })
      const directoryFiles =
        input.action === "upload_directory"
          ? new Map(input.files.map((file) => [file.relativePath, file]))
          : undefined
      if (
        files.length !== input.files.length ||
        (directoryFiles !== undefined &&
          new Set(files.map((file) => file.relativePath)).size !==
            files.length) ||
        files.some((file, index) => {
          const expected = directoryFiles
            ? directoryFiles.get(file.relativePath)
            : input.files[index]
          return (
            !expected ||
            file.name !== expected.name ||
            file.size !== expected.size ||
            file.lastModified !== expected.lastModified ||
            (!directoryFiles && file.relativePath !== "")
          )
        })
      )
        throw new BrowserControlError(
          "browser_input_unconfirmed",
          "The file input did not confirm the selected file metadata. Observe again; do not replay automatically.",
        )
      result = {
        delivered: true,
        action: input.action,
        filesVerified: true,
        files:
          input.action === "upload_directory"
            ? files
            : files.map(({ name, size, lastModified }) => ({
                name,
                size,
                lastModified,
              })),
        cleared: input.action === "upload" && input.files.length === 0,
        events:
          input.action === "upload_directory" || input.files.length
            ? "chromium"
            : "synthetic",
      }
    } catch (cause) {
      failure =
        attempted && cause instanceof BrowserControlError
          ? new BrowserControlError(
              "browser_input_unconfirmed",
              "File selection was attempted but its receipt could not be confirmed. Observe again; do not replay automatically. " +
                cause.message,
            )
          : cause
    }
    await this.#finishInput(group, failure, reference.frame?.sessionId)
    if (!result) throw new Error("Browser file selection produced no result.")
    return result
  }

  async selectOptions(
    input: BrowserSelectRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "element"),
      group = `yakitori_${randomUUID()}`
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal, reference.frame?.sessionId)
    let attempted = false,
      result: JsonObject | undefined,
      failure: unknown
    try {
      const objectId = await this.#resolveReference(reference, group, signal)
      await command("DOM.focus", { backendNodeId: reference.backendNodeId })
      await this.#verifyDocument(reference, signal)
      attempted = true
      const reply = object(
        await command("Runtime.callFunctionOn", {
          objectId,
          returnByValue: true,
          functionDeclaration: selectBrowserOptions.toString(),
          arguments: [{ value: input.options }],
        }),
      )
      const selection = object(object(reply.result).value)
      if (selection.applied === false) attempted = false
      if (selection.ok !== true)
        throw new BrowserControlError(
          attempted ? "browser_input_unconfirmed" : "browser_input_unavailable",
          typeof selection.reason === "string"
            ? selection.reason
            : "The select did not confirm the requested options.",
        )
      if (
        !Array.isArray(selection.values) ||
        !selection.values.every((value) => typeof value === "string")
      )
        throw new Error("Chromium returned invalid selected values.")
      await this.#verifyDocument(reference, signal)
      const confirmed = object(
        await this.#inputReadCommand(
          "Runtime.callFunctionOn",
          {
            objectId,
            returnByValue: true,
            functionDeclaration: verifyBrowserSelection.toString(),
            arguments: [{ value: selection.values }],
          },
          signal,
          reference.frame?.sessionId,
        ),
      )
      if (object(confirmed.result).value !== true)
        throw new BrowserControlError(
          "browser_input_unconfirmed",
          "The select changed after its events. Observe again; do not replay automatically.",
        )
      result = {
        delivered: true,
        action: "select",
        selectionVerified: true,
        values: selection.values,
        events: "synthetic",
      }
    } catch (cause) {
      failure =
        attempted && cause instanceof BrowserControlError
          ? new BrowserControlError(
              "browser_input_unconfirmed",
              "Selection was attempted but its receipt could not be confirmed. Observe again; do not replay automatically. " +
                cause.message,
            )
          : cause
    }
    await this.#finishInput(group, failure, reference.frame?.sessionId)
    if (!result) throw new Error("Browser selection produced no result.")
    return result
  }

  async pressKey(
    input: BrowserKeyRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "element"),
      group = `yakitori_${randomUUID()}`
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal, reference.frame?.sessionId)
    const modifiers = input.modifiers ?? []
    let dispatched = false,
      result: JsonObject | undefined,
      failure: unknown,
      flags = 0
    try {
      const objectId = await this.#resolveReference(reference, group, signal)
      await command("DOM.focus", { backendNodeId: reference.backendNodeId })
      const ensureFocused = async () => {
        await this.#verifyDocument(reference, signal)
        const response = object(
          await this.#inputReadCommand(
            "Runtime.callFunctionOn",
            {
              objectId,
              returnByValue: true,
              functionDeclaration: `function() { return this instanceof Element && this.isConnected && this.ownerDocument === document && this.getRootNode().activeElement === this && !Element.prototype.matches.call(this, ':disabled'); }`,
            },
            signal,
            reference.frame?.sessionId,
          ),
        )
        if (object(response.result).value !== true)
          throw new BrowserControlError(
            "browser_input_unavailable",
            "The exact keyboard target is unavailable or no longer focused.",
          )
      }
      for (const key of [...modifiers, input.key]) {
        await ensureFocused()
        const modifierIndex = ["Alt", "Control", "Meta", "Shift"].indexOf(key)
        const previousFlags = flags
        if (modifierIndex >= 0) flags |= 1 << modifierIndex
        const stroke = browserKeyStroke(key, modifiers)
        signal.throwIfAborted()
        if (this.closed)
          throw new BrowserControlError(
            "browser_unavailable",
            "The owned debugger disconnected.",
          )
        // Register each release before dispatch; unwind key then modifiers in
        // reverse order, independently of cancellation or changed focus.
        this.#heldInputs.push({
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyUp",
            key: stroke.key,
            code: stroke.code,
            windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
            ...(stroke.location ? { location: stroke.location } : {}),
            modifiers: previousFlags,
          },
        })
        dispatched = true
        const editingCommand =
          key === input.key &&
          modifiers.includes("Meta") &&
          !modifiers.includes("Alt") &&
          !modifiers.includes("Control")
            ? key.toLowerCase() === "a" && !modifiers.includes("Shift")
              ? "selectAll"
              : key.toLowerCase() === "z"
                ? modifiers.includes("Shift")
                  ? "redo"
                  : "undo"
                : undefined
            : undefined
        await this.#inputCommand(
          "Input.dispatchKeyEvent",
          {
            type: stroke.text ? "keyDown" : "rawKeyDown",
            ...stroke,
            modifiers: flags,
            ...(editingCommand ? { commands: [editingCommand] } : {}),
          },
          signal,
        )
      }
      await this.#releaseInput()
      const documentChanged = await this.#documentChanged(reference, signal)
      result = {
        delivered: true,
        action: "press",
        key: input.key,
        modifiers,
        documentChanged,
      }
    } catch (cause) {
      failure =
        dispatched && cause instanceof BrowserControlError
          ? new BrowserControlError(
              "browser_input_unconfirmed",
              "Keyboard dispatch was attempted but its receipt could not be confirmed. Observe again; do not replay automatically. " +
                cause.message,
            )
          : cause
    }
    await this.#finishInput(group, failure, reference.frame?.sessionId)
    if (!result) throw new Error("Browser keyboard input produced no result.")
    return result
  }

  async inputPointer(
    input: BrowserPointerRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "element"),
      group = `yakitori_${randomUUID()}`
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal, reference.frame?.sessionId)
    let framePointer: BrowserFramePointer | undefined
    const flushFrameLayout = async () => {
      if (!framePointer) return
      // Hidden WebContentsViews can retain stale compositor hit-test data:
      // root mouse events then reach the parent instead of its OOPIF. A tiny
      // capture requests a current frame without showing or focusing the view.
      await this.#read(signal, async () => {
        try {
          await this.#contents.capturePage(
            { x: 0, y: 0, width: 1, height: 1 },
            { stayHidden: true, stayAwake: true },
          )
        } catch (cause) {
          throw new BrowserControlError(
            "browser_input_unavailable",
            "The page could not produce current compositor hit-test data. Observe again before clicking. " +
              (cause instanceof Error ? cause.message : String(cause)),
          )
        }
      })
    }
    const verifyDocument = async () => {
      const frame = await this.#verifyDocument(reference, signal)
      if (framePointer && frame) framePointer.verifyPath(frame.path)
    }
    let dispatched = false,
      result: JsonObject | undefined,
      failure: unknown
    try {
      const objectId = await this.#resolveReference(reference, group, signal)
      if (reference.frame) {
        const selected = await this.#verifyDocument(reference, signal)
        if (!selected) throw new Error("Missing pointer frame binding.")
        framePointer = new BrowserFramePointer(
          selected.path,
          (method, params = {}, sessionId) =>
            this.#inputReadCommand(method, params, signal, sessionId),
          (method, params = {}, sessionId) =>
            this.#inputCommand(method, params, signal, sessionId),
          group,
        )
        await framePointer.prepare()
        await verifyDocument()
      }
      const probe = async (
        scroll: boolean,
        point?: { x: number; y: number },
      ) => {
        const params = {
          objectId,
          returnByValue: true,
          functionDeclaration: browserPointerGeometry,
          arguments: [{ value: scroll }, { value: point ?? null }],
        }
        const response = object(
          await (scroll
            ? command("Runtime.callFunctionOn", params)
            : this.#inputReadCommand(
                "Runtime.callFunctionOn",
                params,
                signal,
                reference.frame?.sessionId,
              )),
        )
        const value = object(object(response.result).value)
        if (value.ok !== true)
          throw new BrowserControlError(
            "browser_input_unavailable",
            "The exact control has no visible unoccluded click point, or is disabled. Observe again before clicking.",
          )
        if (
          typeof value.x !== "number" ||
          !Number.isFinite(value.x) ||
          typeof value.y !== "number" ||
          !Number.isFinite(value.y)
        )
          throw new Error("Chromium returned an invalid browser click point.")
        return { x: value.x, y: value.y }
      }
      const localPoint = await probe(true)
      await flushFrameLayout()
      const point = framePointer
        ? await framePointer.project(localPoint)
        : localPoint
      const verifyPoint = async () => {
        await probe(false, localPoint)
        if (framePointer) {
          const current = await framePointer.project(localPoint)
          if (
            Math.abs(current.x - point.x) > 0.5 ||
            Math.abs(current.y - point.y) > 0.5
          )
            throw new BrowserControlError(
              "browser_input_unavailable",
              "The frame moved during pointer input. Observe again before clicking.",
            )
        }
      }
      dispatched = input.action === "hover"
      await this.#inputCommand(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          ...point,
          buttons: 0,
        },
        signal,
      )
      await verifyDocument()
      await flushFrameLayout()
      await verifyPoint()
      await verifyDocument()
      signal.throwIfAborted()
      if (this.closed)
        throw new BrowserControlError(
          "browser_unavailable",
          "The owned debugger disconnected.",
        )
      if (input.action === "click") {
        const button = input.button ?? "left"
        for (
          let clickCount = 1;
          clickCount <= (input.clickCount ?? 1);
          clickCount++
        ) {
          // A double click is two intentional press/release pairs. A failed
          // pair stops the sequence; cleanup never replays a press.
          await verifyDocument()
          await verifyPoint()
          signal.throwIfAborted()
          if (this.closed)
            throw new BrowserControlError(
              "browser_unavailable",
              "The owned debugger disconnected.",
            )
          this.#heldInputs.push({
            method: "Input.dispatchMouseEvent",
            params: {
              type: "mouseReleased",
              ...point,
              button,
              buttons: 0,
              clickCount,
            },
          })
          dispatched = true
          await this.#inputCommand(
            "Input.dispatchMouseEvent",
            {
              type: "mousePressed",
              ...point,
              button,
              buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
              clickCount,
            },
            signal,
          )
          await this.#releaseInput()
        }
      } else if (input.action === "scroll") {
        dispatched = true
        await this.#inputCommand(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            ...point,
            buttons: 0,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          },
          signal,
        )
      }
      const documentChanged = await this.#documentChanged(reference, signal)
      result = {
        delivered: true,
        action: input.action,
        point,
        documentChanged,
      }
    } catch (cause) {
      failure =
        dispatched && cause instanceof BrowserControlError
          ? new BrowserControlError(
              "browser_input_unconfirmed",
              "Pointer dispatch was attempted but its receipt could not be confirmed. Observe again; do not replay automatically. " +
                cause.message,
            )
          : cause
    }
    await this.#finishInput(
      group,
      failure,
      reference.frame?.sessionId,
      framePointer?.sessions,
    )
    if (!result) throw new Error("Browser pointer input produced no result.")
    return result
  }
}
