export function readBrowserTextControl(
  this: Element,
  requireFocus: boolean,
  selectAll: boolean,
): unknown {
  const root = this.getRootNode()
  if (
    !this.isConnected ||
    this.ownerDocument !== document ||
    (requireFocus &&
      (!(root instanceof Document || root instanceof ShadowRoot) ||
        root.activeElement !== this)) ||
    this.matches(':disabled, [inert], [aria-disabled="true"]')
  )
    return { ok: false }
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    if (this.readOnly || this.value.length > 65536) return { ok: false }
    if (
      typeof this.selectionStart === "number" &&
      typeof this.selectionEnd === "number"
    ) {
      if (selectAll) this.select()
      return {
        ok: true,
        value: this.value,
        start: this.selectionStart,
        end: this.selectionEnd,
      }
    }
    if (
      this instanceof HTMLInputElement &&
      [
        "email",
        "number",
        "date",
        "time",
        "month",
        "week",
        "datetime-local",
      ].includes(this.type)
    ) {
      const replaces = selectAll || !["email", "number"].includes(this.type)
      return {
        ok: true,
        setter: true,
        value: this.value,
        start: replaces ? 0 : this.value.length,
        end: this.value.length,
      }
    }
    return { ok: false }
  }
  if (!(this instanceof HTMLElement) || !this.isContentEditable)
    return { ok: false }
  const selection =
    root instanceof ShadowRoot
      ? (
          root as ShadowRoot & { getSelection(): Selection | null }
        ).getSelection()
      : document.getSelection()
  const value = this.textContent ?? ""
  if (value.length > 65536 || !selection) return { ok: false }
  const range = document.createRange()
  range.selectNodeContents(this)
  if (selectAll) {
    selection.removeAllRanges()
    selection.addRange(range)
    return { ok: true, value, start: 0, end: value.length }
  }
  if (!requireFocus) return { ok: true, value, start: 0, end: value.length }
  if (selection.rangeCount !== 1) return { ok: false }
  const selected = selection.getRangeAt(0)
  if (
    !this.contains(selected.startContainer) ||
    !this.contains(selected.endContainer)
  )
    return { ok: false }
  range.setEnd(selected.startContainer, selected.startOffset)
  const start = range.toString().length
  return { ok: true, value, start, end: start + selected.toString().length }
}

export function setBrowserInputValue(
  this: HTMLInputElement,
  expected: string,
): unknown {
  const root = this.getRootNode()
  if (
    !(this instanceof HTMLInputElement) ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    !(root instanceof Document || root instanceof ShadowRoot) ||
    root.activeElement !== this ||
    this.readOnly ||
    this.matches(':disabled, [inert], [aria-disabled="true"]') ||
    ![
      "email",
      "number",
      "date",
      "time",
      "month",
      "week",
      "datetime-local",
    ].includes(this.type)
  )
    return { applied: false }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set
  if (!setter) return { applied: false }
  const trial = document.createElement("input")
  trial.type = this.type
  setter.call(trial, expected)
  if (trial.value !== expected) return { applied: false }
  setter.call(this, expected)
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  this.dispatchEvent(new Event("change", { bubbles: true }))
  return { applied: true }
}
