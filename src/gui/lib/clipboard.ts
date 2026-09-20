// Electron denies renderer permission requests, including the web Clipboard
// API. Only the trusted GUI preload exposes the native write-only operation.
export async function writeClipboardText(text: string): Promise<void> {
  if (window.yakitoriDesktop !== undefined) {
    await window.yakitoriDesktop.writeClipboardText(text)
    return
  }
  if (navigator.clipboard?.writeText === undefined)
    throw new Error("Clipboard is unavailable in this browser.")
  await navigator.clipboard.writeText(text)
}
