import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { BrowserDocumentScope } from "./browser-protocol.ts"

export type BrowserDialogCommand = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  confirmed?: (result: unknown) => void,
) => Promise<unknown>

// Electron replaces the main window's prompt with an unsupported bridge.
// Borrow Chromium's native binding in the original window, retaining the
// temporary realm until the synchronous native dialog returns.
function installPrompt(expectedUrl: string) {
  if (document.URL !== expectedUrl || window.document !== document)
    throw new Error("The prompt document changed.")
  const original = window.prompt
  const installed = function prompt(message?: string, defaultValue?: string) {
    const frame = document.createElement("iframe")
    frame.hidden = true
    document.documentElement.append(frame)
    try {
      if (!frame.contentWindow)
        throw new Error("Native prompt realm unavailable.")
      return frame.contentWindow.prompt.call(window, message, defaultValue)
    } finally {
      frame.remove()
    }
  }
  const ticket = { document, original, installed }
  window.prompt = installed
  if (window.prompt !== installed)
    throw new Error("Native prompt cannot be installed.")
  return ticket
}

function restorePrompt(this: ReturnType<typeof installPrompt>) {
  const view = this.document.defaultView
  if (view?.document === this.document && view.prompt === this.installed)
    view.prompt = this.original
}

type PromptBinding = {
  scope: BrowserDocumentScope
  command: BrowserDialogCommand
  group: string
  runtimeEnabled: boolean
  expired: boolean
  context?: { id: number; uniqueId: string }
  contextGone: boolean
  installAttempted: boolean
  ticket?: string
}

export class BrowserPromptAdapter {
  readonly #debug: WebContents["debugger"]
  #binding: PromptBinding | undefined
  #disconnected = false
  readonly #message = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
    const binding = this.#binding
    if (
      !binding ||
      (sessionId || undefined) !== binding.scope.frame?.sessionId ||
      typeof params !== "object" ||
      params === null
    )
      return
    if (
      method === "Runtime.executionContextCreated" &&
      "context" in params &&
      typeof params.context === "object" &&
      params.context !== null
    ) {
      const context = params.context
      if (
        "id" in context &&
        typeof context.id === "number" &&
        "uniqueId" in context &&
        typeof context.uniqueId === "string" &&
        "auxData" in context &&
        typeof context.auxData === "object" &&
        context.auxData !== null &&
        "isDefault" in context.auxData &&
        context.auxData.isDefault === true &&
        "frameId" in context.auxData &&
        context.auxData.frameId === binding.scope.document.frameId &&
        !binding.expired
      )
        binding.context = { id: context.id, uniqueId: context.uniqueId }
    } else if (
      method === "Runtime.executionContextDestroyed" &&
      binding.context &&
      (("executionContextUniqueId" in params &&
        params.executionContextUniqueId === binding.context.uniqueId) ||
        ("executionContextId" in params &&
          params.executionContextId === binding.context.id))
    ) {
      binding.contextGone = true
      binding.expired = true
    } else if (method === "Runtime.executionContextsCleared") {
      binding.contextGone = true
      binding.expired = true
    } else if (
      (method === "Page.frameNavigated" &&
        "frame" in params &&
        typeof params.frame === "object" &&
        params.frame !== null &&
        "id" in params.frame &&
        params.frame.id === binding.scope.document.frameId) ||
      (method === "Page.navigatedWithinDocument" &&
        "frameId" in params &&
        params.frameId === binding.scope.document.frameId)
    ) {
      binding.expired = true
    }
  }

  constructor(debug: WebContents["debugger"]) {
    this.#debug = debug
    debug.on("message", this.#message)
  }

  async install(
    scope: BrowserDocumentScope,
    command: BrowserDialogCommand,
  ): Promise<void> {
    if (this.#binding)
      throw new Error("A native prompt adapter already owns this renderer.")
    const binding: PromptBinding = {
      scope,
      command,
      group: `yakitori_prompt_${randomUUID()}`,
      runtimeEnabled: false,
      contextGone: false,
      installAttempted: false,
      expired: false,
    }
    this.#binding = binding
    await command("Runtime.enable", {}, scope.frame?.sessionId, () => {
      binding.runtimeEnabled = true
    })
    scope.closed.throwIfAborted()
    if (binding.expired || !binding.context)
      throw new BrowserControlError(
        "browser_prompt_unavailable",
        "The observed document's original main-world context is unavailable.",
      )
    // Unique context IDs cannot be reused for a new document after navigation.
    binding.installAttempted = true
    const result = await command(
      "Runtime.callFunctionOn",
      {
        uniqueContextId: binding.context.uniqueId,
        functionDeclaration: installPrompt.toString(),
        arguments: [{ value: scope.document.url }],
        objectGroup: binding.group,
      },
      scope.frame?.sessionId,
      (result) => {
        if (
          typeof result === "object" &&
          result !== null &&
          "result" in result &&
          typeof result.result === "object" &&
          result.result !== null &&
          "objectId" in result.result &&
          typeof result.result.objectId === "string"
        )
          binding.ticket = result.result.objectId
      },
    )
    if (!binding.ticket)
      throw new BrowserControlError(
        "browser_prompt_unavailable",
        "Chromium could not install a native prompt in the original document.",
        { cause: result },
      )
  }

  async restore(): Promise<void> {
    const binding = this.#binding
    if (!binding) return
    const { scope, command } = binding
    // CDP session loss destroys remote handles, not a main-world JavaScript
    // override. Keep it owned until restoration, realm destruction or tab death.
    if (
      (this.#disconnected || scope.closed.aborted) &&
      binding.installAttempted &&
      !binding.contextGone
    )
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "The prompt restore channel was lost while the original document may still contain its adapter. Close the original browser target before resuming computer input.",
      )
    if (!this.#disconnected && !scope.closed.aborted) {
      if (binding.ticket && !binding.contextGone) {
        try {
          const restored = await command(
            "Runtime.callFunctionOn",
            {
              objectId: binding.ticket,
              functionDeclaration: restorePrompt.toString(),
              returnByValue: true,
            },
            scope.frame?.sessionId,
          )
          if (
            typeof restored === "object" &&
            restored !== null &&
            "exceptionDetails" in restored
          )
            throw new BrowserControlError(
              "browser_cleanup_failed",
              "The original document rejected native prompt restoration.",
            )
        } catch (cause) {
          // Navigation can destroy the original realm while restoration waits.
          // Only that explicit event proves its wrapper no longer needs removal.
          if (!binding.contextGone) throw cause
        }
      }
      if (!binding.contextGone)
        await command(
          "Runtime.releaseObjectGroup",
          { objectGroup: binding.group },
          scope.frame?.sessionId,
        )
      if (binding.runtimeEnabled)
        await command("Runtime.disable", {}, scope.frame?.sessionId)
    }
    this.#binding = undefined
  }

  disconnected(): void {
    this.#disconnected = true
    this.#debug.off("message", this.#message)
  }

  close(targetDestroyed = false): void {
    if (
      !targetDestroyed &&
      this.#binding?.installAttempted &&
      !this.#binding.contextGone
    )
      throw new BrowserControlError(
        "browser_cleanup_failed",
        "Native prompt restoration remains owned by its original browser target.",
      )
    this.#binding = undefined
    this.#debug.off("message", this.#message)
  }
}
