import { randomUUID } from "node:crypto"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import {
  type BrowserDocumentIdentity,
  documentIdentity,
} from "./browser-accessibility.ts"
import type { BrowserProtocolCommand } from "./browser-protocol.ts"
import type { BrowserFrameSessions } from "./browser-sessions.ts"

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
  readonly #sessions: BrowserFrameSessions
  #references = new Map<string, FrameTicket>()
  readonly #unsubscribe: () => void

  constructor(sessions: BrowserFrameSessions) {
    this.#sessions = sessions
    this.#unsubscribe = sessions.onRetired((sessionId) => {
      for (const [token, ticket] of this.#references)
        if (ticket.frame.sessionId === sessionId) this.#references.delete(token)
    })
  }

  close(): void {
    this.#unsubscribe()
    this.#references.clear()
  }

  async #snapshot(command: BrowserProtocolCommand): Promise<{
    root: BrowserDocumentIdentity
    frames: Map<string, BrowserFrameBinding>
  }> {
    await this.#sessions.configure(command)
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
    for (const [sessionId, parent] of this.#sessions.children())
      add(
        await this.#sessions.readInSession(
          command,
          "Page.getFrameTree",
          {},
          sessionId,
        ),
        sessionId,
        parent.parentFrameId,
      )
    return { root, frames }
  }

  async list(
    command: BrowserProtocolCommand,
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
    command: BrowserProtocolCommand,
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
