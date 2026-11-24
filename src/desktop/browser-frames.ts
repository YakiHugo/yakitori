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
type FrameSnapshot = {
  root: BrowserDocumentIdentity
  frames: Map<string, BrowserFrameBinding>
}

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
  readonly #unsubscribeChanges: () => void
  #cached: FrameSnapshot | undefined
  #version = 0

  constructor(sessions: BrowserFrameSessions) {
    this.#sessions = sessions
    this.#unsubscribe = sessions.onRetired((sessionId) => {
      for (const [token, ticket] of this.#references)
        if (ticket.frame.sessionId === sessionId) this.#references.delete(token)
    })
    this.#unsubscribeChanges = sessions.onFrameChange(
      (method, params, sessionId) => {
        this.#version++
        const cached = this.#cached
        if (!cached) return
        if (!record(params)) {
          this.#cached = undefined
          return
        }
        if (
          method === "Page.navigatedWithinDocument" &&
          typeof params.frameId === "string" &&
          typeof params.url === "string"
        ) {
          const known = cached.frames.get(params.frameId)
          if (!known || known.sessionId !== sessionId) return
          const document = { ...known.document, url: params.url }
          cached.frames.set(params.frameId, { ...known, document })
          if (document.frameId === cached.root.frameId) cached.root = document
          return
        }
        if (
          method === "Page.frameNavigated" &&
          record(params.frame) &&
          typeof params.frame.id === "string" &&
          typeof params.frame.loaderId === "string" &&
          typeof params.frame.url === "string"
        ) {
          const document = documentIdentity({
            frameTree: { frame: params.frame },
          })
          const known = cached.frames.get(document.frameId)
          if (
            known &&
            known.sessionId === sessionId &&
            document.frameId !== cached.root.frameId
          ) {
            cached.frames.set(document.frameId, {
              ...known,
              document,
              ...(typeof params.frame.parentId === "string"
                ? { parentId: params.frame.parentId }
                : {}),
            })
            this.#dropDescendants(cached, document.frameId)
            return
          }
        }
        if (
          method === "Page.frameDetached" &&
          typeof params.frameId === "string" &&
          params.frameId !== cached.root.frameId
        ) {
          this.#dropDescendants(cached, params.frameId)
          cached.frames.delete(params.frameId)
          return
        }
        this.#cached = undefined
      },
    )
  }

  #dropDescendants(snapshot: FrameSnapshot, frameId: string): void {
    const removed = new Set([frameId])
    for (const parent of removed)
      for (const [id, frame] of snapshot.frames)
        if (frame.parentId === parent) {
          removed.add(id)
          snapshot.frames.delete(id)
        }
  }

  close(): void {
    this.#unsubscribe()
    this.#unsubscribeChanges()
    this.#references.clear()
    this.#cached = undefined
  }

  async #snapshot(command: BrowserProtocolCommand): Promise<FrameSnapshot> {
    await this.#sessions.configure(command)
    if (this.#cached) return this.#cached
    const version = this.#version
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
    const snapshot = { root, frames }
    if (version === this.#version) this.#cached = snapshot
    return snapshot
  }

  async list(
    command: BrowserProtocolCommand,
    offset: number,
    pinned: Iterable<string> = [],
  ): Promise<{ result: JsonObject; root: BrowserDocumentIdentity }> {
    const retained = new Map<string, FrameTicket>()
    for (const token of pinned) {
      const ticket = this.#references.get(token)
      if (ticket) retained.set(token, ticket)
    }
    this.#references = retained
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
    const version = this.#version
    const rootTree = await command("Page.getFrameTree")
    if (!sameDocument(ticket.root, documentIdentity(rootTree)))
      throw new BrowserControlError(
        "browser_frame_stale",
        "The observed main document changed. List frames again.",
      )
    const frameTree =
      frame.sessionId === undefined
        ? rootTree
        : await this.#sessions.readInSession(
            command,
            "Page.getFrameTree",
            {},
            frame.sessionId,
          )
    const pending = [record(frameTree) ? frameTree.frameTree : undefined]
    let confirmed = false
    for (const entry of pending) {
      if (!record(entry) || !record(entry.frame)) continue
      if (entry.frame.id === frame.document.frameId) {
        confirmed =
          sameDocument(
            frame.document,
            documentIdentity({ frameTree: entry }),
          ) &&
          (typeof entry.frame.parentId !== "string" ||
            entry.frame.parentId === frame.parentId)
        break
      }
      if (Array.isArray(entry.childFrames))
        for (const child of entry.childFrames) pending.push(child)
      if (pending.length > 512) break
    }
    if (!confirmed || version !== this.#version)
      throw new BrowserControlError(
        "browser_frame_stale",
        "The frame changed during verification. List frames again.",
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
