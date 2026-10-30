import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  BrowserControlError,
  type BrowserPointerRequest,
  type BrowserTextInputRequest,
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

type BrowserControlReference = Readonly<{
  kind: "text" | "pointer"
  backendNodeId: number
  document: ReturnType<typeof documentIdentity>
}>

export class BrowserDocumentConnection {
  #closed = false
  #heldInput:
    | Readonly<{
        method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent"
        params: Record<string, unknown>
      }>
    | undefined
  #references = new Map<string, BrowserControlReference>()
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
    const held = this.#heldInput
    if (!held) return
    const contents = this.#contents
    if (contents.isDestroyed()) {
      this.#heldInput = undefined
      return
    }
    if (this.closed || !this.#debug.isAttached())
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The debugger disconnected with an unconfirmed held input. Close this browser target before resuming input.",
      )
    try {
      await this.#debug.sendCommand(held.method, held.params)
      this.#heldInput = undefined
    } catch (cause) {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The held browser input could not be released: " +
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
    if (this.#heldInput)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Confirm held-input cleanup before observing again.",
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
      const references = new Map<string, BrowserControlReference>()
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
        const pointerReference =
          typeof backendNodeId === "number" &&
          Number.isSafeInteger(backendNodeId) &&
          backendNodeId > 0 &&
          !["RootWebArea", "StaticText", "InlineTextBox"].includes(role)
            ? `browser_click_${randomUUID()}`
            : undefined
        const entry: JsonObject = {
          nodeId: node.nodeId,
          ...(reference ? { inputReference: reference } : {}),
          ...(pointerReference ? { clickReference: pointerReference } : {}),
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
          references.set(reference, {
            kind: "text",
            backendNodeId,
            document: before,
          })
        if (pointerReference && typeof backendNodeId === "number")
          references.set(pointerReference, {
            kind: "pointer",
            backendNodeId,
            document: before,
          })
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

  #consumeReference(
    token: string,
    kind: BrowserControlReference["kind"],
  ): BrowserControlReference {
    if (this.#heldInput)
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
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (this.closed)
      throw new BrowserControlError(
        "browser_unavailable",
        "The owned debugger disconnected.",
      )
    // A dispatched input command must acknowledge before cancellation can finish.
    try {
      return await this.#debug.sendCommand(method, params)
    } catch (cause) {
      throw new BrowserControlError(
        "browser_protocol_error",
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }

  async #verifyDocument(
    expected: BrowserControlReference["document"],
    signal: AbortSignal,
  ) {
    const current = documentIdentity(
      await this.#inputCommand("Page.getFrameTree", {}, signal),
    )
    if (
      current.frameId !== expected.frameId ||
      current.documentId !== expected.documentId ||
      current.url !== expected.url ||
      this.#contents.getURL() !== current.url
    )
      throw new BrowserControlError(
        "browser_target_changed",
        "The observed document navigated. Observe it again.",
      )
    return current
  }

  async #resolveReference(
    reference: BrowserControlReference,
    group: string,
    signal: AbortSignal,
  ): Promise<string> {
    await this.#verifyDocument(reference.document, signal)
    const world = object(
      await this.#inputCommand(
        "Page.createIsolatedWorld",
        {
          frameId: reference.document.frameId,
          worldName: "yakitori-browser-input",
        },
        signal,
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

  async #finishInput(group: string, failure: unknown): Promise<void> {
    // Release is independent of cancellation. A failed key-up is surfaced to
    // the shared input gate and remains retryable by finishTurn/closeSession.
    const [inputCleanup, groupCleanup] = await Promise.allSettled([
      this.#releaseInput(),
      this.closed
        ? undefined
        : this.#debug.sendCommand("Runtime.releaseObjectGroup", {
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
        "Held-input cleanup could not be confirmed.",
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
      this.#inputCommand(method, params, signal)
    const verifyDocument = () =>
      this.#verifyDocument(reference.document, signal)
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
        this.#heldInput = {
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          },
        }
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
    await this.#finishInput(group, failure)
    if (!result) throw new Error("Browser input produced no result.")
    return result
  }

  async inputPointer(
    input: BrowserPointerRequest,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    signal.throwIfAborted()
    const reference = this.#consumeReference(input.reference, "pointer"),
      group = `yakitori_${randomUUID()}`
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
      await this.#verifyDocument(reference.document, signal)
      await probe(false, point)
      await this.#verifyDocument(reference.document, signal)
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
          await this.#verifyDocument(reference.document, signal)
          await probe(false, point)
          signal.throwIfAborted()
          if (this.closed)
            throw new BrowserControlError(
              "browser_unavailable",
              "The owned debugger disconnected.",
            )
          this.#heldInput = {
            method: "Input.dispatchMouseEvent",
            params: {
              type: "mouseReleased",
              ...point,
              button,
              buttons: 0,
              clickCount,
            },
          }
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
      const current = documentIdentity(await command("Page.getFrameTree"))
      result = {
        delivered: true,
        action: input.action,
        point,
        documentChanged:
          current.frameId !== reference.document.frameId ||
          current.documentId !== reference.document.documentId ||
          current.url !== reference.document.url,
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
