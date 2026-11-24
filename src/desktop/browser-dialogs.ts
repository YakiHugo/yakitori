import type { WebContents } from "electron"
import {
  BrowserControlError,
  type BrowserDialogRule,
} from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"
import {
  type BrowserDialogCommand,
  BrowserPromptAdapter,
} from "./browser-prompt.ts"
import type { BrowserDocumentScope } from "./browser-protocol.ts"

// A serial tool caller cannot reply after a click blocked by a modal dialog.
// One explicitly armed rule is applied from the protocol event, before input ACK.
export class BrowserDialogs {
  readonly #debug: WebContents["debugger"]
  readonly #prompt: BrowserPromptAdapter
  #scope:
    | (BrowserDocumentScope & {
        response: BrowserDialogRule
        command: BrowserDialogCommand
        ready: boolean
        expired: boolean
        state: "waiting" | "answering" | "answered" | "mismatch"
        observed?: JsonObject
        browserAccepted?: boolean
        nativeUnloadAllowed?: boolean
      })
    | undefined
  #reply: Promise<void> | undefined
  #failure: BrowserControlError | undefined
  #pending:
    | {
        frameId: string
        url: string
        type: string
        message: string
        sessionId?: string
      }
    | undefined
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
    if (typeof params === "object" && params !== null) {
      if (
        method === "Page.javascriptDialogOpening" &&
        "frameId" in params &&
        typeof params.frameId === "string" &&
        "url" in params &&
        typeof params.url === "string" &&
        "type" in params &&
        typeof params.type === "string" &&
        "message" in params &&
        typeof params.message === "string"
      ) {
        this.#pending = {
          frameId: params.frameId,
          url: params.url,
          type: params.type,
          message: params.message,
          ...(sessionId ? { sessionId } : {}),
        }
      } else if (
        method === "Page.javascriptDialogClosed" &&
        this.#pending?.sessionId === (sessionId || undefined)
      ) {
        this.#pending = undefined
      }
    }
    const scope = this.#scope
    if (
      !scope ||
      scope.closed.aborted ||
      (sessionId || undefined) !== scope.frame?.sessionId ||
      typeof params !== "object" ||
      params === null
    )
      return
    if (
      (method === "Page.frameNavigated" &&
        "frame" in params &&
        typeof params.frame === "object" &&
        params.frame !== null &&
        "id" in params.frame &&
        params.frame.id === scope.document.frameId) ||
      (method === "Page.navigatedWithinDocument" &&
        "frameId" in params &&
        params.frameId === scope.document.frameId)
    ) {
      scope.expired = true
      return
    }
    if (
      method === "Page.javascriptDialogClosed" &&
      scope.state === "answering" &&
      scope.response.type === "beforeunload" &&
      scope.response.accept &&
      "frameId" in params &&
      params.frameId === scope.document.frameId &&
      "result" in params &&
      params.result === true
    ) {
      scope.browserAccepted = true
      return
    }
    if (
      method !== "Page.javascriptDialogOpening" ||
      !scope.ready ||
      scope.expired ||
      scope.state !== "waiting"
    )
      return
    if (
      !("frameId" in params) ||
      !("url" in params) ||
      !("type" in params) ||
      !("message" in params) ||
      typeof params.type !== "string" ||
      typeof params.message !== "string"
    )
      return
    const matches =
      params.frameId === scope.document.frameId &&
      params.url === scope.document.url &&
      params.type === scope.response.type &&
      (scope.response.message === undefined ||
        params.message === scope.response.message)
    scope.observed = {
      type: params.type.slice(0, 64),
      message: params.message.slice(0, 8192),
      messageTruncated: params.message.length > 8192,
      inScope:
        params.frameId === scope.document.frameId &&
        params.url === scope.document.url,
    }
    if (!matches) {
      scope.state = "mismatch"
      return
    }
    scope.state = "answering"
    const currentDialog = this.#pending
    this.#reply = scope
      .command(
        "Page.handleJavaScriptDialog",
        {
          accept: scope.response.accept,
          ...(scope.response.promptText === undefined
            ? {}
            : { promptText: scope.response.promptText }),
        },
        scope.frame?.sessionId,
        () => {
          scope.state = "answered"
          if (this.#pending === currentDialog) this.#pending = undefined
          if (this.#scope === scope) this.#failure = undefined
        },
      )
      .then(
        () => {
          scope.state = "answered"
          if (this.#pending === currentDialog) this.#pending = undefined
        },
        (cause: unknown) => {
          // The protocol boundary translates operational failures before they reach
          // this event callback. Retain them for the input/turn cleanup boundary.
          if (scope.state === "answered") return
          this.#failure =
            cause instanceof BrowserControlError
              ? cause
              : new BrowserControlError(
                  "browser_protocol_error",
                  "JavaScript dialog response failed.",
                  { cause },
                )
        },
      )
  }

  constructor(debug: WebContents["debugger"]) {
    this.#debug = debug
    this.#prompt = new BrowserPromptAdapter(debug)
    debug.on("message", this.#message)
  }

  async arm(
    scope: BrowserDocumentScope,
    response: BrowserDialogRule,
    command: BrowserDialogCommand,
  ): Promise<void> {
    if (this.#scope)
      throw new BrowserControlError(
        "browser_dialog_armed",
        "Disarm the existing dialog rule before arming another response.",
      )
    scope.closed.throwIfAborted()
    const armed = {
      ...scope,
      response,
      command,
      ready: false,
      expired: false,
      state: "waiting" as const,
    }
    this.#scope = armed
    await command("Page.enable", {}, scope.frame?.sessionId)
    if (response.type === "prompt") await this.#prompt.install(scope, command)
    armed.ready = true
  }

  async settle(): Promise<void> {
    await this.#reply
    if (this.#failure)
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "JavaScript dialog response completion could not be confirmed. The tab remains quarantined until cleanup succeeds.",
        { cause: this.#failure },
      )
  }

  async answer(
    scope: BrowserDocumentScope,
    response: BrowserDialogRule,
    command: BrowserDialogCommand,
  ): Promise<JsonObject> {
    const pending = this.#pending
    if (
      this.#scope?.state === "answering" ||
      !pending ||
      pending.type !== response.type ||
      pending.url !== scope.document.url ||
      pending.frameId !== scope.document.frameId ||
      pending.sessionId !== scope.frame?.sessionId ||
      (response.message !== undefined && response.message !== pending.message)
    )
      throw new BrowserControlError(
        "browser_dialog_stale",
        "There is no observed open dialog matching this document and response.",
      )
    await command(
      "Page.handleJavaScriptDialog",
      {
        accept: response.accept,
        ...(response.promptText === undefined
          ? {}
          : { promptText: response.promptText }),
      },
      pending.sessionId,
    )
    if (this.#pending === pending) this.#pending = undefined
    return { answered: true, type: pending.type, accepted: response.accept }
  }

  allowNavigationUnload(fromUrl: string): boolean {
    const scope = this.#scope
    if (
      !scope ||
      scope.closed.aborted ||
      scope.expired ||
      scope.nativeUnloadAllowed ||
      scope.frame ||
      scope.document.url !== fromUrl ||
      scope.response.type !== "beforeunload" ||
      !scope.response.accept ||
      scope.observed?.inScope !== true ||
      !(scope.state === "answered" || scope.browserAccepted)
    )
      return false
    scope.nativeUnloadAllowed = true
    return true
  }

  inspect(): JsonObject {
    const scope = this.#scope
    if (!scope?.ready) {
      const pending = this.#pending
      return {
        armed: false,
        ...(pending
          ? {
              dialog: {
                type: pending.type,
                message: pending.message.slice(0, 8192),
              },
            }
          : {}),
      }
    }
    return {
      armed: true,
      state: scope.state,
      expired: scope.expired || scope.closed.aborted,
      fromUrl: scope.document.url,
      ...(scope.observed ? { dialog: scope.observed } : {}),
    }
  }

  async disarm(): Promise<void> {
    await this.settle()
    try {
      await this.#prompt.restore()
    } catch (cause) {
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Native prompt restoration could not be confirmed.",
        { cause },
      )
    }
    this.#scope = undefined
    this.#reply = undefined
  }

  disconnected(): void {
    this.#pending = undefined
    this.#prompt.disconnected()
    this.#debug.off("message", this.#message)
  }

  close(targetDestroyed = false): void {
    this.#pending = undefined
    this.#scope = undefined
    this.#reply = undefined
    this.#failure = undefined
    this.#prompt.close(targetDestroyed)
    this.#debug.off("message", this.#message)
  }
}
