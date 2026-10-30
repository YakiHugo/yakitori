import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { BrowserProtocolCommand } from "./browser-frames.ts"

// Serialized in the exact input's isolated world. Only a trusted native change
// or cancel ends enumeration; clearing its value does not cancel Chromium's work.
export function prepareBrowserDirectory(this: Element): {
  completion: Promise<string>
} | null {
  if (
    !(this instanceof HTMLInputElement) ||
    this.type !== "file" ||
    !this.webkitdirectory ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    Element.prototype.matches.call(this, ":disabled")
  )
    return null

  let finish: (event: string) => void = () => {}
  const dispose = () => {
    EventTarget.prototype.removeEventListener.call(
      this,
      "change",
      changed,
      true,
    )
    EventTarget.prototype.removeEventListener.call(
      this,
      "cancel",
      changed,
      true,
    )
  }
  const changed = (event: Event) => {
    if (!event.isTrusted || event.target !== this) return
    dispose()
    finish(event.type)
  }
  const completion = new Promise<string>((resolve) => {
    finish = resolve
  })
  EventTarget.prototype.addEventListener.call(this, "change", changed, true)
  EventTarget.prototype.addEventListener.call(this, "cancel", changed, true)
  return { completion }
}

export async function setBrowserDirectory(
  command: BrowserProtocolCommand,
  objectId: string,
  backendNodeId: number,
  directory: string,
  group: string,
): Promise<boolean> {
  const prepared = await command("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: prepareBrowserDirectory.toString(),
    objectGroup: group,
    returnByValue: false,
  })
  if (
    typeof prepared === "object" &&
    prepared !== null &&
    "result" in prepared &&
    typeof prepared.result === "object" &&
    prepared.result !== null &&
    "value" in prepared.result &&
    prepared.result.value === null &&
    !("exceptionDetails" in prepared)
  )
    return false
  if (
    typeof prepared !== "object" ||
    prepared === null ||
    !("result" in prepared) ||
    typeof prepared.result !== "object" ||
    prepared.result === null ||
    !("objectId" in prepared.result) ||
    typeof prepared.result.objectId !== "string" ||
    "exceptionDetails" in prepared
  )
    throw new BrowserControlError(
      "browser_input_unavailable",
      "The exact directory input is no longer available.",
    )
  await command("DOM.setFileInputFiles", { backendNodeId, files: [directory] })
  // The setFileInputFiles acknowledgement starts asynchronous enumeration.
  // This second protocol promise owns its actual completion, even on cancellation.
  const completed = await command("Runtime.callFunctionOn", {
    objectId: prepared.result.objectId,
    functionDeclaration: "function () { return this.completion }",
    awaitPromise: true,
    returnByValue: true,
  })
  if (
    typeof completed !== "object" ||
    completed === null ||
    !("result" in completed) ||
    typeof completed.result !== "object" ||
    completed.result === null ||
    !("value" in completed.result) ||
    !["change", "cancel"].includes(String(completed.result.value)) ||
    "exceptionDetails" in completed
  )
    throw new BrowserControlError(
      "browser_input_unconfirmed",
      "Directory enumeration did not confirm native completion. Do not replay automatically.",
    )
  return true
}
