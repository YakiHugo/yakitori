import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type {
  BrowserFrameReadMethod,
  BrowserProtocolCommand,
} from "./browser-protocol.ts"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Child CDP lifetimes and configuration belong to the connection, independently
// of the document references created by an individual frame observation.
export class BrowserFrameSessions {
  #retired = new Set<(sessionId: string) => void>()
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
      for (const sessionId of removed)
        for (const listener of this.#retired) listener(sessionId)
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

  onRetired(listener: (sessionId: string) => void): () => void {
    this.#retired.add(listener)
    return () => {
      this.#retired.delete(listener)
    }
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
    this.#retired.clear()
    this.#debug.off("message", this.#message)
  }

  async #sessionCommand(
    command: BrowserProtocolCommand,
    method:
      | BrowserFrameReadMethod
      | "Target.setAutoAttach"
      | "Runtime.releaseObjectGroup",
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    const signal = this.sessionClosed(sessionId)
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

  sessionClosed(sessionId: string): AbortSignal {
    const session = this.#sessions.get(sessionId)
    if (!session)
      throw new BrowserControlError(
        "browser_frame_stale",
        "The frame renderer disconnected. List frames again.",
      )
    return session.closed.signal
  }

  readInSession(
    command: BrowserProtocolCommand,
    method: BrowserFrameReadMethod,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return sessionId === undefined
      ? command(method, params)
      : this.#sessionCommand(command, method, params, sessionId)
  }

  async releaseObjects(
    group: string,
    command: BrowserProtocolCommand,
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

  async configure(command: BrowserProtocolCommand): Promise<void> {
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
  }

  children(): IterableIterator<
    readonly [
      string,
      Readonly<{ parentSessionId?: string; parentFrameId?: string }>,
    ]
  > {
    return this.#sessions.entries()
  }
}
