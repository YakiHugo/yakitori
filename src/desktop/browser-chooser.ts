import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { BrowserControlReference } from "./browser-accessibility.ts"
import type {
  BrowserDocumentScope,
  BrowserProtocolCommand,
} from "./browser-protocol.ts"

// CDP intercepts a renderer's pickers; only the approved document's input may
// become a file reference. Other local frames cannot receive that reference.
export class BrowserFileChooser {
  readonly #debug: WebContents["debugger"]
  #scope:
    | (BrowserDocumentScope & {
        ready: boolean
        opened: number | undefined
        ambiguous: boolean
        unsupported: boolean
        expired: boolean
        outside: boolean
      })
    | undefined
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
    const scope = this.#scope
    // Electron reports root events with ""; root protocol commands omit it.
    const sourceSessionId = sessionId || undefined
    if (
      !scope ||
      scope.closed.aborted ||
      sourceSessionId !== scope.frame?.sessionId
    )
      return
    if (
      method === "Page.frameNavigated" &&
      typeof params === "object" &&
      params !== null &&
      "frame" in params &&
      typeof params.frame === "object" &&
      params.frame !== null &&
      "id" in params.frame &&
      params.frame.id === scope.document.frameId &&
      "loaderId" in params.frame &&
      params.frame.loaderId !== scope.document.documentId
    ) {
      scope.expired = true
      scope.opened = undefined
      return
    }
    if (method !== "Page.fileChooserOpened" || scope.expired) return
    if (typeof params !== "object" || params === null || !("frameId" in params))
      return
    if (params.frameId !== scope.document.frameId) {
      scope.outside = true
      return
    }
    if (
      !("backendNodeId" in params) ||
      typeof params.backendNodeId !== "number" ||
      !Number.isSafeInteger(params.backendNodeId) ||
      params.backendNodeId <= 0
    ) {
      scope.unsupported = true
      return
    }
    if (scope.opened !== undefined) scope.ambiguous = true
    else scope.opened = params.backendNodeId
  }
  constructor(debug: WebContents["debugger"]) {
    this.#debug = debug
    debug.on("message", this.#message)
  }

  async arm(
    document: BrowserDocumentScope,
    command: BrowserProtocolCommand,
  ): Promise<void> {
    if (this.#scope)
      throw new BrowserControlError(
        "browser_chooser_armed",
        "Disarm the existing file chooser scope before arming another document.",
      )
    document.closed.throwIfAborted()
    const scope = {
      ...document,
      ready: false,
      ambiguous: false,
      unsupported: false,
      expired: false,
      outside: false,
      opened: undefined as number | undefined,
    }
    this.#scope = scope
    await command("Page.enable", {}, document.frame?.sessionId)
    await command(
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
      document.frame?.sessionId,
    )
    scope.ready = true
  }

  inspect(): {
    scope: BrowserDocumentScope
    backendNodeId: number | undefined
  } {
    const scope = this.#scope
    if (!scope?.ready || scope.closed.aborted)
      throw new BrowserControlError(
        "browser_chooser_unarmed",
        "Arm the current document before opening its file input.",
      )
    if (scope.ambiguous)
      throw new BrowserControlError(
        "browser_chooser_ambiguous",
        "More than one file chooser opened in this scope. Disarm and inspect the page before trying again.",
      )
    if (scope.expired)
      throw new BrowserControlError(
        "browser_target_changed",
        "The armed document navigated. Disarm interception and observe the new document before arming it.",
      )
    if (scope.outside)
      throw new BrowserControlError(
        "browser_chooser_outside_scope",
        "A file picker opened in another document in this renderer. No files were provided. Disarm and observe that document before arming it.",
      )
    if (scope.unsupported)
      throw new BrowserControlError(
        "browser_chooser_unsupported",
        "This picker did not identify an exact HTML file input. No files were provided.",
      )
    return { scope, backendNodeId: scope.opened }
  }

  async disarm(command: BrowserProtocolCommand): Promise<boolean> {
    const scope = this.#scope
    if (!scope) return false
    if (!scope.closed.aborted)
      await command(
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
        scope.frame?.sessionId,
      )
    this.#scope = undefined
    return true
  }

  selected(reference: BrowserControlReference): void {
    const scope = this.#scope
    if (
      scope?.opened === reference.backendNodeId &&
      scope.frame?.sessionId === reference.frame?.sessionId
    )
      scope.opened = undefined
  }

  close(): void {
    this.#scope = undefined
    this.#debug.off("message", this.#message)
  }
}
