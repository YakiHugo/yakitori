import { randomUUID } from "node:crypto"
import type { JsonObject } from "../protocol/events.ts"

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid browser observation data.")
  return value as Record<string, unknown>
}

export type BrowserDocumentIdentity = Readonly<{
  frameId: string
  documentId: string
  url: string
}>

export function documentIdentity(value: unknown): BrowserDocumentIdentity {
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

export type BrowserControlReference = Readonly<{
  kind: "text" | "pointer"
  backendNodeId: number
  document: BrowserDocumentIdentity
}>

export function browserAccessibility(
  value: unknown,
  document: BrowserDocumentIdentity,
): {
  nodes: JsonObject[]
  references: Map<string, BrowserControlReference>
  truncated: boolean
} {
  const tree = object(value)
  if (!Array.isArray(tree.nodes))
    throw new Error("Chromium returned no accessibility nodes.")
  // CDP exposes depth but no node-count limit on its intermediate AX reply.
  // These bounds cover host output/IPC, not Chromium's traversal allocation.
  const nodes: JsonObject[] = []
  const references = new Map<string, BrowserControlReference>()
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
    const role = String(primitive(node.role, 512) ?? "")
    const backendNodeId = node.backendDOMNodeId
    const reference =
      typeof backendNodeId === "number" &&
      Number.isSafeInteger(backendNodeId) &&
      backendNodeId > 0 &&
      ["textbox", "searchbox"].includes(role)
        ? `browser_node_${randomUUID()}`
        : undefined
    const pointerReference =
      typeof backendNodeId === "number" &&
      Number.isSafeInteger(backendNodeId) &&
      backendNodeId > 0 &&
      !["RootWebArea", "StaticText", "InlineTextBox"].includes(role)
        ? `browser_click_${randomUUID()}`
        : undefined
    const entry: JsonObject = {
      nodeId: node.nodeId,
      ...(reference ? { inputReference: reference } : {}),
      ...(pointerReference ? { clickReference: pointerReference } : {}),
      role,
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
    if (reference && typeof backendNodeId === "number")
      references.set(reference, {
        kind: "text",
        backendNodeId,
        document,
      })
    if (pointerReference && typeof backendNodeId === "number")
      references.set(pointerReference, {
        kind: "pointer",
        backendNodeId,
        document,
      })
  }
  return { nodes, references, truncated }
}
