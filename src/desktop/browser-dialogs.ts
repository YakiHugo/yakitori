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
      })
    | undefined
  #reply: Promise<void> | undefined
  #failure: BrowserControlError | undefined
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
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
          if (this.#scope === scope) this.#failure = undefined
        },
      )
      .then(
        () => {
          scope.state = "answered"
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
        "JavaScript dialog response completion could not be confirmed. Computer input remains quarantined until cleanup succeeds.",
        { cause: this.#failure },
      )
  }

  inspect(): JsonObject {
    const scope = this.#scope
    if (!scope?.ready) return { armed: false }
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
    this.#prompt.disconnected()
    this.#debug.off("message", this.#message)
  }

  close(targetDestroyed = false): void {
    this.#scope = undefined
    this.#reply = undefined
    this.#failure = undefined
    this.#prompt.close(targetDestroyed)
    this.#debug.off("message", this.#message)
  }
}
