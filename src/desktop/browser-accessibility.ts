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
  editable: boolean
  backendNodeId: number
  document: BrowserDocumentIdentity
  frame?: Readonly<{ reference: string; sessionId?: string }>
}>

export type BrowserDomControl = Readonly<{
  backendNodeId: number
  role: string
  name: string
  editable: boolean
}>

const editableRoles = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
])
const interactiveRoles = new Set([
  ...editableRoles,
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "treeitem",
  "gridcell",
])

export function browserAccessibility(
  payload: unknown,
  document: BrowserDocumentIdentity,
  issueRef: () => string,
  options: Readonly<{
    interactiveOnly?: boolean
    scopeBackendId?: number
    dom?: readonly BrowserDomControl[]
  }> = {},
): {
  nodes: JsonObject[]
  references: Map<string, BrowserControlReference>
  outline: string
  truncated: boolean
} {
  const tree = object(payload)
  if (!Array.isArray(tree.nodes))
    throw new Error("Chromium returned no accessibility nodes.")
  const index = new Map<string, Record<string, unknown>>()
  const parents = new Map<string, string>()
  let truncated = false
  for (const raw of tree.nodes) {
    const node = object(raw)
    if (typeof node.nodeId !== "string")
      throw new Error(
        "Chromium returned an invalid accessibility node identity.",
      )
    index.set(node.nodeId, node)
    if (typeof node.parentId === "string")
      parents.set(node.nodeId, node.parentId)
  }
  for (const [id, node] of index) {
    for (const child of Array.isArray(node.childIds) ? node.childIds : []) {
      if (typeof child !== "string" || !index.has(child)) {
        truncated = true
        continue
      }
      if (!parents.has(child)) parents.set(child, id)
    }
  }
  const children = new Map<string | undefined, string[]>()
  for (const id of index.keys()) {
    const guessed = parents.get(id)
    const parent =
      guessed && guessed !== id && index.has(guessed) ? guessed : undefined
    const siblings = children.get(parent) ?? []
    siblings.push(id)
    children.set(parent, siblings)
  }

  const primitive = (
    raw: unknown,
    limit = 384,
  ): string | number | boolean | undefined => {
    if (raw === undefined) return
    const value = object(raw).value
    if (typeof value === "string") {
      if (value.length > limit) truncated = true
      return value.slice(0, limit)
    }
    if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value
  }
  const dom = new Map(
    options.dom?.map((control) => [control.backendNodeId, control]),
  )
  const roots =
    options.scopeBackendId === undefined
      ? (children.get(undefined) ?? [])
      : [...index]
          .filter(
            ([, node]) => node.backendDOMNodeId === options.scopeBackendId,
          )
          .slice(0, 1)
          .map(([id]) => id)
  type Row = {
    role: string
    name: string
    value?: string | number | boolean
    properties: JsonObject
    backendNodeId?: number
    editable: boolean
    interactive: boolean
    children: Row[]
  }
  const rows: Row[] = []
  const visited = new Set<string>()
  const pending = roots.toReversed().map((id) => ({ id, target: rows }))
  while (pending.length) {
    const entry = pending.pop()
    if (!entry || visited.has(entry.id)) continue
    visited.add(entry.id)
    const node = index.get(entry.id)
    if (!node) continue
    let descendants = entry.target
    if (node.ignored !== true) {
      const backendNodeId =
        typeof node.backendDOMNodeId === "number" &&
        Number.isSafeInteger(node.backendDOMNodeId) &&
        node.backendDOMNodeId > 0
          ? node.backendDOMNodeId
          : undefined
      const supplemental =
        backendNodeId === undefined ? undefined : dom.get(backendNodeId)
      if (backendNodeId !== undefined) dom.delete(backendNodeId)
      const axRole = String(primitive(node.role, 80) ?? "")
      const role =
        supplemental && ["generic", "none", ""].includes(axRole)
          ? supplemental.role
          : axRole
      const name = String(primitive(node.name) || supplemental?.name || "")
      const value = primitive(node.value)
      const properties: JsonObject = Object.fromEntries(
        (Array.isArray(node.properties) ? node.properties : []).flatMap(
          (raw) => {
            const property = object(raw)
            if (typeof property.name !== "string")
              throw new Error(
                "Chromium returned an invalid accessibility property.",
              )
            const scalar = primitive(property.value, 80)
            return scalar === undefined ? [] : [[property.name, scalar]]
          },
        ),
      )
      const editable =
        supplemental?.editable === true || editableRoles.has(role)
      const interactive =
        editable ||
        supplemental !== undefined ||
        interactiveRoles.has(role) ||
        properties.focusable === true
      if (
        role !== "InlineTextBox" &&
        (!["generic", "none", ""].includes(role) ||
          name ||
          value !== undefined ||
          interactive)
      ) {
        descendants = []
        entry.target.push({
          role,
          name,
          ...(value === undefined ? {} : { value }),
          properties,
          ...(backendNodeId === undefined ? {} : { backendNodeId }),
          editable,
          interactive,
          children: descendants,
        })
      }
    }
    for (const id of (children.get(entry.id) ?? []).toReversed())
      pending.push({ id, target: descendants })
  }
  if (options.scopeBackendId === undefined) {
    const container =
      rows.length === 1 && rows[0]?.role === "RootWebArea"
        ? rows[0].children
        : rows
    for (const control of dom.values())
      container.push({
        ...control,
        interactive: true,
        properties: {},
        children: [],
      })
  } else if (!roots.length) {
    const control = dom.get(options.scopeBackendId)
    if (control)
      rows.push({ ...control, interactive: true, properties: {}, children: [] })
  }

  const retained = new Set<Row>()
  if (options.interactiveOnly) {
    const traversal = [...rows]
    for (const row of traversal)
      for (const child of row.children) traversal.push(child)
    for (const row of traversal.reverse())
      if (row.interactive || row.children.some((child) => retained.has(child)))
        retained.add(row)
  }
  const text = (value: unknown) =>
    JSON.stringify(value)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029")
  const nodes: JsonObject[] = []
  const lines: string[] = []
  const references = new Map<string, BrowserControlReference>()
  const displayed = rows.toReversed().map((row) => ({ row, depth: 0 }))
  let bytes = 0
  while (displayed.length) {
    const entry = displayed.pop()
    if (!entry) break
    const { row, depth } = entry
    if (options.interactiveOnly && !retained.has(row)) continue
    const ref =
      row.backendNodeId !== undefined &&
      !["RootWebArea", "StaticText"].includes(row.role)
        ? issueRef()
        : undefined
    const node: JsonObject = {
      depth,
      role: row.role,
      name: row.name,
      ...(ref === undefined ? {} : { ref }),
      ...(row.value === undefined ? {} : { value: row.value }),
      ...(Object.keys(row.properties).length
        ? { properties: row.properties }
        : {}),
    }
    const flags = [
      "checked",
      "selected",
      "expanded",
      "disabled",
      "focused",
      "required",
    ].flatMap((key) => {
      const value = row.properties[key]
      return value === undefined ? [] : [key.concat("=", text(value))]
    })
    const role = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(row.role)
      ? row.role
      : text(row.role)
    const line =
      "  ".repeat(Math.min(depth, 24)) +
      [
        ...(ref ? ["[".concat(ref, "]")] : []),
        role,
        ...(row.name ? [text(row.name)] : []),
        ...(row.value === undefined ? [] : ["value=".concat(text(row.value))]),
        ...flags,
      ].join(" ")
    const size =
      Buffer.byteLength(JSON.stringify(node)) + Buffer.byteLength(line) + 2
    if (nodes.length >= 1000 || bytes + size > 128 * 1024) {
      truncated = true
      break
    }
    bytes += size
    lines.push(line)
    nodes.push(node)
    if (ref && row.backendNodeId !== undefined)
      references.set(ref, {
        editable: row.editable,
        backendNodeId: row.backendNodeId,
        document,
      })
    for (const child of row.children.toReversed())
      displayed.push({ row: child, depth: depth + 1 })
  }
  return { nodes, references, outline: lines.join("\n"), truncated }
}
