import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  type BrowserCaptureRequest,
  BrowserControlError,
  type BrowserKeyRequest,
  type BrowserPointerRequest,
  type BrowserTextInputRequest,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import {
  type BrowserControlReference,
  browserAccessibility,
  documentIdentity,
} from "./browser-accessibility.ts"
import { captureBrowserPage } from "./browser-capture.ts"
import { BrowserFrames, type BrowserReadCommand } from "./browser-frames.ts"
import { browserKeyStroke } from "./browser-key.ts"

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid browser observation data.")
  return value as Record<string, unknown>
}

export class BrowserDocumentConnection {
  #closed = false
  #heldInputs: Readonly<{
    method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent"
    params: Record<string, unknown>
  }>[] = []
  #references = new Map<string, BrowserControlReference>()
  readonly #contents: WebContents
  readonly #debug: WebContents["debugger"]
  readonly #frameCatalog: BrowserFrames
  readonly #detached = () => {
    this.#closed = true
    this.#references.clear()
    this.#frameCatalog.close()
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
    this.#frameCatalog = new BrowserFrames(debug)
    debug.on("detach", this.#detached)
  }

  get closed(): boolean {
    return this.#closed || this.#contents.isDestroyed()
  }

  async #releaseInput(): Promise<void> {
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
  }

  async close(): Promise<void> {
    await this.#releaseInput()
    if (!this.closed && this.#debug.isAttached()) this.#debug.detach()
    this.#closed = true
    this.#references.clear()
    this.#debug.off("detach", this.#detached)
    this.#frameCatalog.close()
  }

  async #read<T>(
    signal: AbortSignal,
    run: (command: BrowserReadCommand) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted()
    if (this.#heldInputs.length)
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
      const pending: Promise<unknown> = debug
        .sendCommand(method, params, sessionId)
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
      return await Promise.race([run(command), aborted])
    } finally {
      deadline.removeEventListener("abort", abort)
    }
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
    if (this.#heldInputs.length)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-input cleanup before sending more input.",
      )
    const reference = this.#references.get(token)
    this.#references.clear()
    if (!reference || reference.kind !== kind || this.closed)
      throw new BrowserControlError(
        "browser_reference_stale",
        "Observe this document again before typing or clicking.",
      )
    return reference
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
    // A dispatched input command must acknowledge before cancellation can finish.
    try {
      return await this.#debug.sendCommand(method, params, sessionId)
    } catch (cause) {
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
          (method, params = {}, sessionId) =>
            this.#inputCommand(method, params, signal, sessionId),
        )
      : undefined
    const expected = reference.document
    const current =
      frame?.frame.document ??
      documentIdentity(
        await this.#inputCommand("Page.getFrameTree", {}, signal),
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
    return current
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
      await this.#inputCommand(
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
        await this.#inputCommand(
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
  ): Promise<void> {
    // Release is independent of cancellation. A failed key-up is surfaced to
    // the shared input gate and remains retryable by finishTurn/closeSession.
    const [inputCleanup, groupCleanup] = await Promise.allSettled([
      this.#releaseInput(),
      this.closed ||
      (sessionId !== undefined && !this.#frameCatalog.ownsSession(sessionId))
        ? undefined
        : this.#debug.sendCommand(
            "Runtime.releaseObjectGroup",
            { objectGroup: group },
            sessionId,
          ),
    ])
    if (inputCleanup?.status === "rejected") {
      const causes = [
        inputCleanup.reason,
        ...(failure === undefined ? [] : [failure]),
        ...(groupCleanup?.status === "rejected" ? [groupCleanup.reason] : []),
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
    if (
      groupCleanup?.status === "rejected" &&
      !this.closed &&
      (sessionId === undefined || this.#frameCatalog.ownsSession(sessionId))
    ) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, groupCleanup.reason],
          "Browser operation and object cleanup failed.",
        )
      throw groupCleanup.reason
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
        const response = object(
          await command("Runtime.callFunctionOn", {
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
          await command("Runtime.callFunctionOn", {
            objectId,
            returnByValue: true,
            functionDeclaration: `function() { return this instanceof Element && this.isConnected && this.ownerDocument === document && this.getRootNode().activeElement === this && !Element.prototype.matches.call(this, ':disabled'); }`,
          }),
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
    if (reference.frame)
      throw new BrowserControlError(
        "browser_frame_pointer_unavailable",
        "Pointer actions currently require the main frame. Text and keyboard actions can use this frame's references.",
      )
    const command = (method: string, params: Record<string, unknown> = {}) =>
      this.#inputCommand(method, params, signal)
    let dispatched = false,
      result: JsonObject | undefined,
      failure: unknown
    try {
      const objectId = await this.#resolveReference(reference, group, signal)
      // Fixed code in the target's isolated world. Hit-test the painted control,
      // including its closest shadow root and the outer document's occlusion.
      const geometry = `function(scroll, point) {
        if (!(this instanceof Element) || !this.isConnected || this.ownerDocument !== document || Element.prototype.matches.call(this, ':disabled')) return {ok:false};
        if (scroll) Element.prototype.scrollIntoView.call(this, {block:'center',inline:'center',behavior:'instant'});
        const doc=this.ownerDocument, root=this.getRootNode();
        let outer=this, outerRoot=root;
        while (outerRoot instanceof ShadowRoot) { outer=outerRoot.host; outerRoot=outer.getRootNode(); }
        const hits=(x,y)=>{
          const globalHit=Document.prototype.elementFromPoint.call(doc,x,y);
          if (root instanceof ShadowRoot && globalHit !== outer) return false;
          let hit=root instanceof ShadowRoot ? root.elementFromPoint(x,y) : globalHit;
          while (hit) {
            if (Node.prototype.contains.call(this,hit)) return true;
            const hitRoot=hit.getRootNode(); hit=hitRoot instanceof ShadowRoot ? hitRoot.host : null;
          }
          return false;
        };
        if (point) return {ok:hits(point.x,point.y),x:point.x,y:point.y};
        const rects=Element.prototype.getClientRects.call(this), view=doc.defaultView;
        // Bound geometry work for very long inline content; this is an input
        // implementation safety boundary, not a limit on the page's contents.
        for(let i=0;i<Math.min(rects.length,16);i++) {
          const rect=rects[i], left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(view.innerWidth,rect.right),bottom=Math.min(view.innerHeight,rect.bottom);
          if(right<=left || bottom<=top)continue;
          const x=(left+right)/2,y=(top+bottom)/2;
          if(hits(x,y))return {ok:true,x,y};
        }
        return {ok:false};
      }`
      const probe = async (
        scroll: boolean,
        point?: { x: number; y: number },
      ) => {
        const response = object(
          await command("Runtime.callFunctionOn", {
            objectId,
            returnByValue: true,
            functionDeclaration: geometry,
            arguments: [{ value: scroll }, { value: point ?? null }],
          }),
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
      const point = await probe(true)
      dispatched = input.action === "hover"
      await command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
        buttons: 0,
      })
      await this.#verifyDocument(reference, signal)
      await probe(false, point)
      await this.#verifyDocument(reference, signal)
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
          await this.#verifyDocument(reference, signal)
          await probe(false, point)
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
          await command("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button,
            buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
            clickCount,
          })
          await this.#releaseInput()
        }
      } else if (input.action === "scroll") {
        dispatched = true
        await command("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          buttons: 0,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
        })
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
    await this.#finishInput(group, failure)
    if (!result) throw new Error("Browser pointer input produced no result.")
    return result
  }
}
