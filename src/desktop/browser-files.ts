// These fixed functions are serialized into the exact file input's isolated
// world. They capture no host values and never receive executable caller code.
export function inspectBrowserFiles(
  this: Element,
  readFiles: boolean,
): {
  ok: boolean
  multiple?: boolean
  directory?: boolean
  reason?: string
  files?: {
    name: string
    size: number
    lastModified: number
    relativePath: string
  }[]
} {
  if (
    !(this instanceof HTMLInputElement) ||
    this.type !== "file" ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    Element.prototype.matches.call(this, ":disabled")
  )
    return {
      ok: false,
      reason: "The exact file input is unavailable or disabled.",
    }
  if (!readFiles)
    return {
      ok: true,
      multiple: this.multiple,
      directory: this.webkitdirectory,
    }
  if (!this.files || this.files.length > 256)
    return {
      ok: false,
      reason:
        "The file list exceeds the 256-file per-action inspection safety bound.",
    }
  const files = Array.from(this.files, (file) => ({
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    relativePath: file.webkitRelativePath,
  }))
  if (new TextEncoder().encode(JSON.stringify(files)).byteLength > 65536)
    return {
      ok: false,
      reason: "File metadata exceeds the 64KiB per-action result safety bound.",
    }
  return { ok: true, files }
}

export function clearBrowserFiles(this: Element): {
  ok: boolean
  applied: boolean
} {
  if (
    !(this instanceof HTMLInputElement) ||
    this.type !== "file" ||
    !this.isConnected ||
    this.ownerDocument !== document ||
    Element.prototype.matches.call(this, ":disabled")
  )
    return { ok: false, applied: false }
  this.value = ""
  EventTarget.prototype.dispatchEvent.call(
    this,
    new Event("input", { bubbles: true, composed: true }),
  )
  if (!this.isConnected || this.ownerDocument !== document)
    return { ok: false, applied: true }
  EventTarget.prototype.dispatchEvent.call(
    this,
    new Event("change", { bubbles: true }),
  )
  return {
    ok:
      this.isConnected &&
      this.ownerDocument === document &&
      this.files?.length === 0,
    applied: true,
  }
}
