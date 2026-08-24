import { realpath } from "node:fs/promises"
import path from "node:path"
import { type BrowserWindow, ipcMain, shell } from "electron"

const openFileChannel = "yakitori:open-file"
const openUrlChannel = "yakitori:open-url"

export function registerResourceOpener(
  workspace: string,
  trustedWindow: BrowserWindow,
): void {
  ipcMain.handle(openFileChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const request = requireFileRequest(input)
    const workspacePath = await realpath(workspace)
    const requestedPath = path.isAbsolute(request.path)
      ? request.path
      : path.resolve(workspacePath, request.path)
    const targetPath = await realpath(requestedPath)
    const error = await shell.openPath(targetPath)
    if (error !== "") throw new Error(error)
  })

  ipcMain.handle(openUrlChannel, async (event, input: unknown) => {
    requireTrustedSender(event.sender, event.senderFrame, trustedWindow)
    const url = requireHttpUrl(input)
    await shell.openExternal(url.href)
  })
}

function requireTrustedSender(
  sender: Electron.WebContents,
  senderFrame: Electron.WebFrameMain | null,
  trustedWindow: BrowserWindow,
): void {
  if (
    trustedWindow.isDestroyed() ||
    sender !== trustedWindow.webContents ||
    senderFrame !== trustedWindow.webContents.mainFrame
  ) {
    throw new Error("Refusing a resource request from an untrusted frame.")
  }
}

function requireFileRequest(input: unknown): {
  readonly path: string
  readonly line?: number
} {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    input.path.length === 0
  ) {
    throw new TypeError("File open request requires a path.")
  }
  if (
    "line" in input &&
    input.line !== undefined &&
    (!Number.isInteger(input.line) || (input.line as number) < 1)
  ) {
    throw new TypeError("File open request line must be a positive integer.")
  }
  return {
    path: input.path,
    ...("line" in input && typeof input.line === "number"
      ? { line: input.line }
      : {}),
  }
}

function requireHttpUrl(input: unknown): URL {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("url" in input) ||
    typeof input.url !== "string"
  ) {
    throw new TypeError("URL open request requires a URL.")
  }
  const url = new URL(input.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs can be opened.")
  }
  return url
}
