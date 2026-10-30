import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import {
  type BrowserDocumentIdentity,
  documentIdentity,
} from "./browser-accessibility.ts"

export type BrowserReadCommand = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>
export type BrowserFrameBinding = Readonly<{
  document: BrowserDocumentIdentity
  sessionId?: string
  parentId?: string
  name: string
}>
type FrameTicket = Readonly<{
  root: BrowserDocumentIdentity
  frame: BrowserFrameBinding
}>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameDocument(
  left: BrowserDocumentIdentity,
  right: BrowserDocumentIdentity,
): boolean {
  return (
    left.frameId === right.frameId &&
    left.documentId === right.documentId &&
    left.url === right.url
  )
}

export class BrowserFrames {
  readonly #debug: WebContents["debugger"]
  #enabled = false
  #configured = new Set<string>()
  #overflow = false
  #sessions = new Map<
    string,
    {
      parentSessionId?: string
      parentFrameId?: string
      closed: AbortController
    }
  >()
  #references = new Map<string, FrameTicket>()
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    parentSessionId?: string,
  ) => {
    if (
      !this.#enabled ||
      !["Target.attachedToTarget", "Target.detachedFromTarget"].includes(method)
    )
      return
    if (!record(params) || typeof params.sessionId !== "string")
      throw new Error("Chromium returned invalid frame session data.")
    if (method === "Target.detachedFromTarget") {
      const removed = new Set([params.sessionId])
      for (const id of removed) {
        this.#sessions
          .get(id)
          ?.closed.abort(
            new BrowserControlError(
              "browser_frame_stale",
              "The frame renderer disconnected. List frames again.",
            ),
          )
        this.#sessions.delete(id)
        this.#configured.delete(id)
        for (const [child, parent] of this.#sessions)
          if (parent.parentSessionId === id) removed.add(child)
      }
      for (const [token, ticket] of this.#references)
        if (ticket.frame.sessionId && removed.has(ticket.frame.sessionId))
          this.#references.delete(token)
      return
    }
    if (!record(params.targetInfo) || params.targetInfo.type !== "iframe")
      return
    // This bounds host bookkeeping, not Chromium's intermediate protocol replies
    // or the page's own renderer allocation. Overflow refuses frame admission.
    if (!this.#sessions.has(params.sessionId) && this.#sessions.size >= 128) {
      this.#overflow = true
      return
    }
    this.#sessions.set(params.sessionId, {
      closed:
        this.#sessions.get(params.sessionId)?.closed ?? new AbortController(),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(typeof params.targetInfo.parentFrameId === "string"
        ? { parentFrameId: params.targetInfo.parentFrameId }
        : {}),
    })
  }

  constructor(debug: WebContents["debugger"]) {
    this.#debug = debug
    debug.on("message", this.#message)
  }

  close(): void {
    this.#enabled = false
    for (const session of this.#sessions.values())
      session.closed.abort(
        new BrowserControlError(
          "browser_unavailable",
          "The owned browser connection closed.",
        ),
      )
    this.#sessions.clear()
    this.#configured.clear()
    this.#references.clear()
    this.#debug.off("message", this.#message)
  }

  async #sessionCommand(
    command: BrowserReadCommand,
    method:
      | "Page.getFrameTree"
      | "Target.setAutoAttach"
      | "Runtime.releaseObjectGroup",
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    const session = this.#sessions.get(sessionId)
    if (!session)
      throw new BrowserControlError(
        "browser_frame_stale",
        "The frame renderer disconnected. List frames again.",
      )
    const signal = session.closed.signal
    let rejectClosed: (reason: unknown) => void = () => {}
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject
    })
    const abort = () => rejectClosed(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    try {
      // Electron may never settle a child command after that session detaches.
      // Only this session's fixed queries/configuration and object cleanup can end here;
      // root-owned input must still await its acknowledgement and key release.
      const pending = Promise.resolve().then(() => {
        signal.throwIfAborted()
        return command(method, params, sessionId)
      })
      return await Promise.race([pending, closed])
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  async releaseObjects(
    group: string,
    command: BrowserReadCommand,
    sessionId?: string,
  ): Promise<void> {
    if (sessionId === undefined) {
      await command("Runtime.releaseObjectGroup", { objectGroup: group })
      return
    }
    if (!this.#sessions.has(sessionId)) return
    try {
      await this.#sessionCommand(
        command,
        "Runtime.releaseObjectGroup",
        { objectGroup: group },
        sessionId,
      )
    } catch (cause) {
      // Remote objects cease to exist with their original session. This does
      // not confirm any root-owned held input; its release is independent.
      if (
        !(cause instanceof BrowserControlError) ||
        !["browser_frame_stale", "browser_unavailable"].includes(cause.code) ||
        this.#sessions.has(sessionId)
      )
        throw cause
    }
  }

  async #snapshot(command: BrowserReadCommand): Promise<{
    root: BrowserDocumentIdentity
    frames: Map<string, BrowserFrameBinding>
  }> {
    this.#enabled = true
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    }
    if (!this.#configured.has("")) {
      await command("Target.setAutoAttach", autoAttach)
      this.#configured.add("")
    }
    // New nested sessions arrive before their parent's configuration ack.
    // Iterating the live map includes them without unowned async event work.
    for (const [sessionId] of this.#sessions) {
      if (this.#overflow) break
      if (!this.#configured.has(sessionId)) {
        await this.#sessionCommand(
          command,
          "Target.setAutoAttach",
          autoAttach,
          sessionId,
        )
        if (this.#sessions.has(sessionId)) this.#configured.add(sessionId)
      }
    }
    if (this.#overflow)
      throw new BrowserControlError(
        "browser_frame_limit",
        "This page exceeds the 128 frame-session host bookkeeping safety bound. Main-frame observation and screenshots remain available.",
      )
    const frames = new Map<string, BrowserFrameBinding>()
    const add = (
      value: unknown,
      sessionId?: string,
      fallbackParentId?: string,
    ) => {
      if (!record(value) || !record(value.frameTree))
        throw new Error("Chromium returned no frame tree.")
      const pending: { node: Record<string, unknown>; parentId?: string }[] = [
        {
          node: value.frameTree,
          ...(fallbackParentId ? { parentId: fallbackParentId } : {}),
        },
      ]
      for (const current of pending) {
        const frame = current.node.frame
        if (!record(frame))
          throw new Error("Chromium returned an invalid frame.")
        const document = documentIdentity({ frameTree: current.node })
        const parentId =
          typeof frame.parentId === "string" ? frame.parentId : current.parentId
        if (!frames.has(document.frameId) && frames.size >= 512)
          throw new BrowserControlError(
            "browser_frame_limit",
            "This page exceeds the 512 frame-identity host bookkeeping safety bound. Main-frame observation and screenshots remain available.",
          )
        const previous = frames.get(document.frameId)
        frames.set(document.frameId, {
          document,
          name: typeof frame.name === "string" ? frame.name : "",
          ...(sessionId ? { sessionId } : {}),
          ...(parentId
            ? { parentId }
            : previous?.parentId
              ? { parentId: previous.parentId }
              : {}),
        })
        if (Array.isArray(current.node.childFrames))
          for (const child of current.node.childFrames) {
            if (!record(child))
              throw new Error("Chromium returned an invalid child frame.")
            if (pending.length >= 512)
              throw new BrowserControlError(
                "browser_frame_limit",
                "This frame tree exceeds the 512 frame-identity host bookkeeping safety bound.",
              )
            pending.push({ node: child, parentId: document.frameId })
          }
      }
    }
    const rootTree = await command("Page.getFrameTree"),
      root = documentIdentity(rootTree)
    add(rootTree)
    for (const [sessionId, parent] of this.#sessions)
      add(
        await this.#sessionCommand(command, "Page.getFrameTree", {}, sessionId),
        sessionId,
        parent.parentFrameId,
      )
    return { root, frames }
  }

  async list(
    command: BrowserReadCommand,
    offset: number,
  ): Promise<{ result: JsonObject; root: BrowserDocumentIdentity }> {
    this.#references.clear()
    const snapshot = await this.#snapshot(command)
    const after = documentIdentity(await command("Page.getFrameTree"))
    if (!sameDocument(snapshot.root, after))
      throw new BrowserControlError(
        "browser_target_changed",
        "The main document changed while listing frames. List frames again.",
      )
    const frames: JsonObject[] = []
    let bytes = 0
    const all = [...snapshot.frames.values()]
    for (const frame of all.slice(offset)) {
      const token = `browser_frame_${randomUUID()}`
      const row = {
        frameReference: token,
        frameId: frame.document.frameId,
        documentId: frame.document.documentId,
        url: frame.document.url.slice(0, 2048),
        urlTruncated: frame.document.url.length > 2048,
        name: frame.name.slice(0, 512),
        main: frame.document.frameId === snapshot.root.frameId,
        remote: frame.sessionId !== undefined,
        ...(frame.parentId ? { parentFrameId: frame.parentId } : {}),
      }
      const size = Buffer.byteLength(JSON.stringify(row))
      if (frames.length >= 64 || bytes + size > 256 * 1024) break
      frames.push(row)
      bytes += size
      this.#references.set(token, { root: snapshot.root, frame })
    }
    return {
      root: after,
      result: {
        document: { ...after, url: after.url.slice(0, 8192) },
        urlTruncated: after.url.length > 8192,
        frames,
        offset,
        ...(offset + frames.length < all.length
          ? { nextOffset: offset + frames.length }
          : {}),
      },
    }
  }

  async resolve(
    token: string,
    command: BrowserReadCommand,
  ): Promise<FrameTicket & { path: BrowserFrameBinding[] }> {
    const ticket = this.#references.get(token)
    if (!ticket)
      throw new BrowserControlError(
        "browser_frame_stale",
        "List frames again before observing this frame.",
      )
    const current = await this.#snapshot(command),
      frame = current.frames.get(ticket.frame.document.frameId)
    if (
      !sameDocument(ticket.root, current.root) ||
      !frame ||
      !sameDocument(ticket.frame.document, frame.document) ||
      frame.sessionId !== ticket.frame.sessionId ||
      frame.parentId !== ticket.frame.parentId
    )
      throw new BrowserControlError(
        "browser_frame_stale",
        "The observed frame document, renderer or parent changed. List frames again.",
      )
    const path: BrowserFrameBinding[] = [frame]
    const visited = new Set([frame.document.frameId])
    while (path[0]?.parentId) {
      const parent = current.frames.get(path[0].parentId)
      if (!parent || visited.has(parent.document.frameId))
        throw new BrowserControlError(
          "browser_frame_stale",
          "The frame ancestry is incomplete. List frames again.",
        )
      visited.add(parent.document.frameId)
      path.unshift(parent)
    }
    if (path[0]?.document.frameId !== current.root.frameId)
      throw new BrowserControlError(
        "browser_frame_stale",
        "The frame no longer belongs to the observed main document.",
      )
    return { ...ticket, path }
  }
}
