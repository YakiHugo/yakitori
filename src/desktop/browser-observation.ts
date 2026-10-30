import type { WebContents } from "electron"
import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type { JsonObject } from "../protocol/events.ts"

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid browser observation data.")
  return value as Record<string, unknown>
}

function documentIdentity(value: unknown) {
  const frame = object(object(object(value).frameTree).frame)
  if (
    typeof frame.id !== "string" ||
    typeof frame.loaderId !== "string" ||
    typeof frame.url !== "string"
  )
    throw new Error("Chromium returned no live document identity.")
  // CDP separates the document URL and its same-document hash fragment.
  return {
    frameId: frame.id,
    documentId: frame.loaderId,
    url:
      frame.url +
      (typeof frame.urlFragment === "string" ? frame.urlFragment : ""),
  }
}

export async function observeBrowserDocument(
  contents: WebContents,
  signal: AbortSignal,
): Promise<JsonObject> {
  signal.throwIfAborted()
  if (
    contents.isDestroyed() ||
    !/^https?:\/\//.test(contents.getURL()) ||
    contents.isLoadingMainFrame()
  )
    throw new BrowserControlError(
      "browser_unready",
      "Wait for this browser tab to finish loading before observing it.",
    )
  const debug = contents.debugger
  if (debug.isAttached() || contents.isDevToolsOpened())
    throw new BrowserControlError(
      "browser_busy",
      "Another debugger is attached to this tab. Close its DevTools before observing it.",
    )
  try {
    debug.attach("1.3")
  } catch (cause) {
    throw new BrowserControlError(
      "browser_unavailable",
      cause instanceof Error ? cause.message : String(cause),
    )
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  let rejectAbort: (cause: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const abort = () => {
    // Only read-only CDP commands are exposed here. Detaching stops this owned
    // session and late protocol responses never become observation results.
    if (!contents.isDestroyed() && debug.isAttached()) debug.detach()
    rejectAbort(
      new BrowserControlError(
        "browser_cancelled",
        "Browser observation stopped or exceeded its 10-second operation safety deadline.",
      ),
    )
  }
  deadline.addEventListener("abort", abort, { once: true })
  const command = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (deadline.aborted) {
      abort()
      return aborted
    }
    const pending: Promise<unknown> = debug
      .sendCommand(method, params)
      .catch((cause: unknown) => {
        throw new BrowserControlError(
          "browser_protocol_error",
          cause instanceof Error ? cause.message : String(cause),
        )
      })
    return Promise.race([pending, aborted])
  }
  try {
    if (deadline.aborted) abort()
    const before = documentIdentity(await command("Page.getFrameTree"))
    const tree = object(
      await command("Accessibility.getFullAXTree", {
        frameId: before.frameId,
        depth: 8,
      }),
    )
    if (!Array.isArray(tree.nodes))
      throw new Error("Chromium returned no accessibility nodes.")
    // CDP exposes depth but no node-count limit on its intermediate AX reply.
    // These bounds cover host output/IPC, not Chromium's traversal allocation.
    const nodes: JsonObject[] = []
    const known = new Set(
      tree.nodes.slice(0, 1000).map((value) => object(value).nodeId),
    )
    let bytes = 0,
      truncated = tree.nodes.length > 1000
    const primitive = (
      value: unknown,
      limit = 2048,
    ): string | number | boolean | undefined => {
      if (value === undefined) return
      const scalar = object(value).value
      if (typeof scalar === "string") {
        if (scalar.length > limit) truncated = true
        return scalar.slice(0, limit)
      }
      if (
        typeof scalar === "boolean" ||
        (typeof scalar === "number" && Number.isFinite(scalar))
      )
        return scalar
      return undefined
    }
    for (const rawNode of tree.nodes) {
      const node = object(rawNode)
      if (node.ignored === true) continue
      if (typeof node.nodeId !== "string")
        throw new Error(
          "Chromium returned an invalid accessibility node identity.",
        )
      if (
        Array.isArray(node.childIds) &&
        node.childIds.some((id) => !known.has(id))
      )
        truncated = true
      const state: [string, string | number | boolean][] = []
      if (Array.isArray(node.properties))
        for (const raw of node.properties) {
          const property = object(raw)
          if (typeof property.name !== "string")
            throw new Error(
              "Chromium returned an invalid accessibility property.",
            )
          const value = primitive(property.value)
          if (value !== undefined) state.push([property.name, value])
        }
      const value = primitive(node.value)
      const entry: JsonObject = {
        nodeId: node.nodeId,
        role: String(primitive(node.role, 512) ?? ""),
        name: String(primitive(node.name) ?? ""),
        ...(typeof node.backendDOMNodeId === "number"
          ? { backendNodeId: node.backendDOMNodeId }
          : {}),
        ...(value !== undefined ? { value } : {}),
        ...(state.length ? { properties: Object.fromEntries(state) } : {}),
      }
      const size = Buffer.byteLength(JSON.stringify(entry))
      if (nodes.length >= 1000 || bytes + size > 256 * 1024) {
        truncated = true
        break
      }
      bytes += size
      nodes.push(entry)
    }
    const after = documentIdentity(await command("Page.getFrameTree"))
    if (
      before.frameId !== after.frameId ||
      before.documentId !== after.documentId ||
      before.url !== after.url ||
      contents.isDestroyed() ||
      contents.getURL() !== after.url
    )
      throw new BrowserControlError(
        "browser_target_changed",
        "The browser navigated during observation. List and observe the current target again.",
      )
    if (deadline.aborted)
      throw new BrowserControlError(
        "browser_cancelled",
        "Browser observation stopped.",
      )
    return {
      document: { ...after, url: after.url.slice(0, 8192) },
      nodes,
      truncated,
      depth: 8,
      urlTruncated: after.url.length > 8192,
    }
  } finally {
    deadline.removeEventListener("abort", abort)
    if (!contents.isDestroyed() && debug.isAttached()) debug.detach()
  }
}
