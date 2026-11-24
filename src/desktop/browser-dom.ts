import type { BrowserDomControl } from "./browser-accessibility.ts"
import type { BrowserProtocolCommand } from "./browser-protocol.ts"

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid DOM observation data.")
  return value as Record<string, unknown>
}

export async function scanBrowserControls(
  command: BrowserProtocolCommand,
  frameId: string,
  group: string,
  sessionId?: string,
): Promise<BrowserDomControl[]> {
  const world = record(
    await command(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "yakitori-browser-observation",
      },
      sessionId,
    ),
  )
  if (typeof world.executionContextId !== "number")
    throw new Error("Missing browser observation world.")
  const evaluated = record(
    await command(
      "Runtime.evaluate",
      {
        contextId: world.executionContextId,
        objectGroup: group,
        expression: `(() => {
      const nodes = [], roots = [document];
      let visited = 0;
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let element; (element = walker.nextNode());) {
          if (++visited > 4096 || nodes.length >= 96) return nodes;
          if (element.shadowRoot) roots.push(element.shadowRoot);
          const style = getComputedStyle(element);
          if (style.visibility !== 'visible' || !element.getClientRects().length || element.matches(':disabled, [inert]')) continue;
          const editable = element.isContentEditable && !element.parentElement?.isContentEditable;
          const nativeField = element instanceof HTMLInputElement && ['email','number','date','time','month','week','datetime-local'].includes(element.type);
          const pointer = style.cursor === 'pointer' && (!element.parentElement || getComputedStyle(element.parentElement).cursor !== 'pointer');
          if (editable || nativeField || pointer || element.hasAttribute('onclick') || element.hasAttribute('tabindex')) nodes.push(element);
        }
      }
      return nodes;
    })()`,
      },
      sessionId,
    ),
  )
  const objectId = record(evaluated.result).objectId
  if (typeof objectId !== "string")
    throw new Error("Missing DOM control scan result.")
  const descriptors = record(
    await command(
      "Runtime.getProperties",
      {
        objectId,
        ownProperties: true,
      },
      sessionId,
    ),
  ).result
  if (!Array.isArray(descriptors))
    throw new Error("Missing DOM control descriptors.")
  const controls: BrowserDomControl[] = []
  for (const descriptor of descriptors.slice(0, 96)) {
    const property = record(descriptor)
    if (
      typeof property.name !== "string" ||
      !/^\d+$/.test(property.name) ||
      !property.value
    )
      continue
    const id = record(property.value).objectId
    if (typeof id !== "string") continue
    const node = record(
      record(
        await command(
          "DOM.describeNode",
          { objectId: id, depth: 0 },
          sessionId,
        ),
      ).node,
    )
    if (typeof node.backendNodeId !== "number") continue
    const attrs = new Map<string, string>()
    if (Array.isArray(node.attributes))
      for (let index = 0; index + 1 < node.attributes.length; index += 2) {
        const name: unknown = node.attributes[index],
          value: unknown = node.attributes[index + 1]
        if (typeof name === "string" && typeof value === "string")
          attrs.set(name, value)
      }
    const tag = node.localName,
      inputType = (attrs.get("type") ?? "text").toLowerCase()
    const editable =
      (attrs.has("contenteditable") &&
        attrs.get("contenteditable") !== "false") ||
      tag === "textarea" ||
      (tag === "input" &&
        [
          "text",
          "search",
          "email",
          "tel",
          "url",
          "number",
          "date",
          "time",
          "week",
          "month",
          "datetime-local",
          "password",
        ].includes(inputType))
    controls.push({
      backendNodeId: node.backendNodeId,
      editable,
      role:
        attrs.get("role")?.slice(0, 80) ??
        (editable ? "textbox" : tag === "a" ? "link" : "button"),
      name: (
        attrs.get("aria-label") ??
        attrs.get("title") ??
        attrs.get("placeholder") ??
        attrs.get("id") ??
        ""
      ).slice(0, 384),
    })
  }
  return controls
}

export function readBrowserTextPage(offset: number, limit: number) {
  const blocks: string[] = []
  const encoder = new TextEncoder()
  const tags = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "LI",
    "TABLE",
    "PRE",
    "BLOCKQUOTE",
    "DT",
    "DD",
  ])
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_ELEMENT,
  )
  let visited = 0,
    position = 0,
    bytes = 0
  for (let element = walker.nextNode(); element; element = walker.nextNode()) {
    if (++visited > 16_000) return { blocks, truncated: true }
    if (
      !(element instanceof HTMLElement) ||
      !tags.has(element.tagName) ||
      element.parentElement?.closest("li, table, pre, blockquote") ||
      !element.getClientRects().length ||
      getComputedStyle(element).visibility !== "visible"
    )
      continue
    const raw = element.innerText.trim()
    if (!raw) continue
    if (position++ < offset) continue
    const tag = element.tagName
    const heading = /^H[1-6]$/.test(tag) ? `${"#".repeat(Number(tag[1]))} ` : ""
    const prefix = tag === "LI" ? "- " : tag === "BLOCKQUOTE" ? "> " : heading
    const text =
      prefix +
      (tag === "PRE" || tag === "TABLE" ? raw : raw.replace(/\s+/g, " ")).slice(
        0,
        4096,
      )
    const size = encoder.encode(text).byteLength + 2
    if (blocks.length >= limit || bytes + size > 64 * 1024)
      return { blocks, nextOffset: offset + blocks.length, truncated: false }
    blocks.push(text)
    bytes += size
  }
  return { blocks, truncated: false }
}
