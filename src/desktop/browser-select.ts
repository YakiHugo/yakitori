import type { BrowserSelectRequest } from "../protocol/desktop-browser.ts"

export function verifyBrowserSelection(
  this: Element,
  values: string[],
): boolean {
  if (
    !(this instanceof HTMLSelectElement) ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    this.selectedOptions.length !== values.length
  )
    return false
  return Array.from(this.selectedOptions).every(
    (option, index) => option.value === values[index],
  )
}

// Serialized into the exact select's isolated world. Keep this function closed
// over browser globals only; caller data travels as CDP arguments, never code.
export function selectBrowserOptions(
  this: Element,
  requested: BrowserSelectRequest["options"],
): { ok: boolean; applied: boolean; reason?: string; values?: string[] } {
  const root = this.getRootNode()
  if (
    !(this instanceof HTMLSelectElement) ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    !("activeElement" in root) ||
    root.activeElement !== this ||
    Element.prototype.matches.call(this, ":disabled")
  )
    return {
      ok: false,
      applied: false,
      reason: "The exact select is unavailable, disabled or no longer focused.",
    }
  if ((!this.multiple && requested.length > 1) || this.options.length > 10_000)
    return {
      ok: false,
      applied: false,
      reason:
        "A single select accepts at most one descriptor. Each action has a 10000-option DOM traversal safety bound.",
    }
  const options = Array.from(this.options),
    chosen: HTMLOptionElement[] = []
  for (const selector of requested) {
    const matches = options.filter((option, index) =>
      "index" in selector
        ? index === selector.index
        : "value" in selector
          ? option.value === selector.value
          : option.label === selector.label,
    )
    const option = matches[0]
    if (
      matches.length !== 1 ||
      !option ||
      Element.prototype.matches.call(option, ":disabled")
    )
      return {
        ok: false,
        applied: false,
        reason:
          "An option is missing, ambiguous or disabled. Use an index to distinguish duplicate values or labels.",
      }
    if (!chosen.includes(option)) chosen.push(option)
  }
  const values = chosen.map((option) => option.value)
  if (
    values.some((value) => value.length > 65536) ||
    new TextEncoder().encode(JSON.stringify(values)).byteLength > 65536
  )
    return {
      ok: false,
      applied: false,
      reason:
        "Selected values exceed the 64KiB per-action result safety bound.",
    }
  this.selectedIndex = -1
  for (const option of chosen) option.selected = true
  EventTarget.prototype.dispatchEvent.call(
    this,
    new Event("input", { bubbles: true, composed: true }),
  )
  if (!this.isConnected || this.ownerDocument !== document)
    return {
      ok: false,
      applied: true,
      reason: "The select disappeared during its input event.",
    }
  EventTarget.prototype.dispatchEvent.call(
    this,
    new Event("change", { bubbles: true }),
  )
  const after = Array.from(this.selectedOptions)
  if (
    !this.isConnected ||
    this.ownerDocument !== document ||
    after.length !== chosen.length ||
    chosen.some(
      (option, index) =>
        !after.includes(option) || option.value !== values[index],
    )
  )
    return {
      ok: false,
      applied: true,
      reason:
        "The select did not retain the requested options after its events.",
    }
  return {
    ok: true,
    applied: true,
    values: Array.from(this.selectedOptions, (option) => option.value),
  }
}
