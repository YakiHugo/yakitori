import type { FileTarget, UrlTarget } from "../tool-presentation.ts"

export function fileActionLabel(): "Open in editor" | "Copy path" {
  return window.yakitoriDesktop === undefined ? "Copy path" : "Open in editor"
}

export async function openFileTarget(
  target: FileTarget,
  workspaceRoot?: string,
): Promise<void> {
  if (window.yakitoriDesktop !== undefined) {
    await window.yakitoriDesktop.openFile({
      path: target.path,
      ...(target.line === undefined ? {} : { line: target.line }),
    })
    return
  }
  const path = absoluteDisplayPath(workspaceRoot, target.path)
  await navigator.clipboard.writeText(
    target.line === undefined ? path : `${path}:${target.line}`,
  )
}

export async function openUrlTarget(target: UrlTarget): Promise<void> {
  if (window.yakitoriDesktop !== undefined) {
    await window.yakitoriDesktop.openUrl({ url: target.url })
    return
  }
  window.open(target.url, "_blank", "noopener,noreferrer")
}

function absoluteDisplayPath(
  workspaceRoot: string | undefined,
  path: string,
): string {
  if (path.startsWith("/") || workspaceRoot === undefined) return path
  return `${workspaceRoot.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`
}
