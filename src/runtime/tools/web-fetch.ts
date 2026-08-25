import type { RuntimeTool, ToolExecutionResult } from "./types.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import {
  completeWebFetchExecution,
  webFetchExecution,
} from "./execution-descriptors.ts"

// web_fetch deliberately performs no SSRF protection: it runs with the host
// user's full network authority, same as run_command. This mirrors dsh's
// explicit decision — a local coding agent fetches whatever URL the user or
// repository points it at, and private-network targets are legitimate.

const MAX_URL_CHARACTERS = 2_048
const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 100_000
const DEFAULT_TIMEOUT_MS = 30_000

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SKIP_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
])
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
])
const TEXTUAL_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-www-form-urlencoded",
])

export type WebFetchToolOptions = {
  readonly timeoutMs?: number
  readonly maxBodyBytes?: number
  readonly maxTextCharacters?: number
  readonly maxRedirects?: number
}

export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): RuntimeTool {
  const limits = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
    maxTextCharacters: options.maxTextCharacters ?? MAX_TEXT_CHARACTERS,
    maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
  }

  return {
    name: "web_fetch",
    description:
      "Fetch a specific http(s) URL and return its content as text. Read-only. HTML is converted to plain text with links preserved as markdown. Redirects to a different origin are not followed; call web_fetch again with the redirect URL instead. Binary content types are not supported. Not a search tool — use it only when you already have a URL.",
    approvalRequirement: noToolApprovalRequired,
    effect: "observe",
    describeExecution: webFetchExecution,
    completeExecution: completeWebFetchExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          maxLength: MAX_URL_CHARACTERS,
          description:
            "The http(s) URL to fetch. http URLs are upgraded to https.",
        },
      },
      required: ["url"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseWebFetchInput(input)
      if (!parsed.ok) return failure("invalid_url", parsed.message)
      if (context.signal?.aborted) {
        return failure(
          "aborted",
          "web_fetch was aborted before the request started.",
        )
      }

      // One deadline for the whole exchange, including the body read:
      // aborting the fetch signal also errors a slow-drip response body
      // mid-read, so the timer stays armed until buildResult has consumed
      // the body.
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), limits.timeoutMs)
      const signal =
        context.signal === undefined
          ? timeout.signal
          : AbortSignal.any([timeout.signal, context.signal])
      let current = parsed.url
      let redirects = 0
      try {
        for (;;) {
          const fetched = await fetch(current, {
            redirect: "manual",
            signal,
            headers: { "user-agent": "yakitori web_fetch" },
          })

          const location = redirectLocation(fetched)
          if (location !== undefined) {
            const target = parseRedirectTarget(location, current)
            if (!target.ok) return target.result
            if (target.url.origin !== current.origin) {
              return failure(
                "cross_origin_redirect",
                `web_fetch does not follow redirects to a different origin. The server responded ${fetched.status} with Location: ${target.url.href}. To read that page, call web_fetch again with the new URL.`,
              )
            }
            redirects += 1
            if (redirects > limits.maxRedirects) {
              return failure(
                "too_many_redirects",
                `web_fetch stopped after ${limits.maxRedirects} same-origin redirects (last Location: ${target.url.href}).`,
              )
            }
            current = target.url
            continue
          }

          return await buildResult(fetched, current, redirects, limits)
        }
      } catch (error) {
        if (context.signal?.aborted) {
          return failure("aborted", "web_fetch was aborted.")
        }
        if (timeout.signal.aborted) {
          return failure(
            "fetch_timeout",
            `web_fetch timed out after ${Math.round(limits.timeoutMs / 1_000)}s waiting for ${current.href}.`,
          )
        }
        return failure(
          "network_error",
          `web_fetch failed to fetch ${current.href}: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function redirectLocation(response: Response): string | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined
  return response.headers.get("location") ?? undefined
}

function parseRedirectTarget(
  location: string,
  base: URL,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  let target: URL
  try {
    target = new URL(location, base)
  } catch {
    return {
      ok: false,
      result: failure(
        "invalid_redirect",
        `web_fetch received an unparseable redirect Location: ${location}`,
      ),
    }
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return {
      ok: false,
      result: failure(
        "invalid_redirect",
        `web_fetch only follows redirects to http(s) URLs, got Location: ${target.href}`,
      ),
    }
  }
  if (target.username !== "" || target.password !== "") {
    return {
      ok: false,
      result: failure(
        "invalid_redirect",
        "web_fetch does not follow redirects to URLs with embedded credentials.",
      ),
    }
  }
  return { ok: true, url: upgradeToHttps(target) }
}

async function buildResult(
  response: Response,
  url: URL,
  redirects: number,
  limits: Required<WebFetchToolOptions>,
): Promise<ToolExecutionResult> {
  const contentType = response.headers.get("content-type")
  const kind = classifyContentType(contentType)
  if (kind === "binary") {
    return failure(
      "unsupported_content_type",
      `web_fetch cannot return "${contentType ?? "unknown"}" content from ${url.href}. Only textual content (HTML, text/*, JSON, XML) is supported.`,
    )
  }

  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxBodyBytes) {
    return failure(
      "response_too_large",
      `web_fetch refused ${url.href}: content-length ${declaredLength} bytes exceeds the ${limits.maxBodyBytes}-byte limit.`,
    )
  }

  const body = await readBody(response, limits.maxBodyBytes)
  const charset = charsetOf(contentType)
  const decoded = new TextDecoder(charset).decode(body.bytes)
  const rendered =
    kind === "html" ? htmlToText(decoded) : stripCarriageReturns(decoded)

  const truncated = rendered.length > limits.maxTextCharacters
  const text = truncated
    ? rendered.slice(0, limits.maxTextCharacters)
    : rendered
  const statusLine = `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`
  const markers = [
    ...(body.truncated
      ? [
          `(Response body exceeded ${limits.maxBodyBytes} bytes; content truncated.)`,
        ]
      : []),
    ...(truncated
      ? [
          `(Content truncated at ${limits.maxTextCharacters} of ${rendered.length} characters.)`,
        ]
      : []),
  ]
  const content = [statusLine, "", text, ...markers].join("\n")
  return {
    ok: true,
    output: {
      url: url.href,
      status: response.status,
      contentType: contentType ?? null,
      redirects,
      truncated: truncated || body.truncated,
      characters: text.length,
      content,
    },
    content,
  }
}

async function readBody(
  response: Response,
  maxBodyBytes: number,
): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
  if (response.body === null)
    return { bytes: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBodyBytes) {
      const kept = value.subarray(
        0,
        value.byteLength - (received - maxBodyBytes),
      )
      if (kept.byteLength > 0) chunks.push(kept)
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return { bytes: Buffer.concat(chunks), truncated }
}

type BodyKind = "html" | "text" | "binary"

function classifyContentType(contentType: string | null): BodyKind {
  if (contentType === null) return "text"
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase()
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return "html"
  }
  if (
    mediaType.startsWith("text/") ||
    TEXTUAL_APPLICATION_TYPES.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  ) {
    return "text"
  }
  return "binary"
}

function charsetOf(contentType: string | null): string {
  const label = /charset\s*=\s*"?([^\s;"]+)/i.exec(contentType ?? "")?.[1]
  if (label === undefined) return "utf-8"
  try {
    return new TextDecoder(label).encoding
  } catch {
    return "utf-8"
  }
}

function stripCarriageReturns(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

// Minimal HTML-to-text for a model reader: skip non-content elements, turn
// block-level tags into newlines, keep absolute http(s) links as markdown,
// and preserve <pre> whitespace. Fidelity is intentionally not a goal.
export function htmlToText(html: string): string {
  const token =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?|([^<]+)/g
  let out = ""
  let skipDepth = 0
  let preDepth = 0
  const preLines = new Set<number>()
  const anchors: {
    readonly href: string | undefined
    readonly start: number
  }[] = []

  const emitBreak = () => {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n"
  }

  for (const match of html.matchAll(token)) {
    const [, closing, rawName, attributes, text] = match
    if (text !== undefined) {
      if (skipDepth > 0) continue
      const decoded = decodeEntities(text)
      if (preDepth > 0) {
        const firstLine = lineCount(out)
        out += decoded
        for (let line = firstLine; line <= lineCount(out); line += 1) {
          preLines.add(line)
        }
      } else {
        out += decoded.replace(/\s+/g, " ")
      }
      continue
    }
    if (rawName === undefined) continue // comment or doctype
    const name = rawName.toLowerCase()
    const isClosing = closing === "/"

    if (skipDepth > 0) {
      if (SKIP_ELEMENTS.has(name)) {
        skipDepth += isClosing ? -1 : 1
      }
      continue
    }
    if (SKIP_ELEMENTS.has(name)) {
      if (!isClosing) skipDepth = 1
      continue
    }
    if (name === "pre") {
      preDepth = Math.max(0, preDepth + (isClosing ? -1 : 1))
      emitBreak()
      continue
    }
    if (name === "a") {
      if (isClosing) {
        const anchor = anchors.pop()
        if (anchor !== undefined) out = closeAnchor(out, anchor)
      } else {
        anchors.push({ href: hrefOf(attributes ?? ""), start: out.length })
      }
      continue
    }
    if (BLOCK_ELEMENTS.has(name)) emitBreak()
  }

  return cleanupLines(out, preLines)
}

function closeAnchor(
  out: string,
  anchor: { readonly href: string | undefined; readonly start: number },
): string {
  if (anchor.href === undefined || !/^https?:\/\//i.test(anchor.href)) {
    return out
  }
  const label = out.slice(anchor.start).trim().replace(/\s+/g, " ")
  if (label === "" || label === anchor.href) return out
  return `${out.slice(0, anchor.start)}[${label}](${anchor.href})`
}

function hrefOf(attributes: string): string | undefined {
  const value =
    /href\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ??
    /href\s*=\s*'([^']*)'/i.exec(attributes)?.[1] ??
    /href\s*=\s*([^\s>]+)/i.exec(attributes)?.[1]
  return value === undefined ? undefined : decodeEntities(value).trim()
}

function cleanupLines(out: string, preLines: ReadonlySet<number>): string {
  const lines = out
    .split("\n")
    .map((line, index) => (preLines.has(index) ? line : line.trim()))
  const kept: string[] = []
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) {
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
  return kept.join("\n")
}

function lineCount(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith("#x")) {
        return codePoint(Number.parseInt(body.slice(2), 16), whole)
      }
      if (body.startsWith("#")) {
        return codePoint(Number.parseInt(body.slice(1), 10), whole)
      }
      return NAMED_ENTITIES[body] ?? whole
    },
  )
}

function codePoint(value: number, fallback: string): string {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0x10_ffff ||
    (value >= 0xd8_00 && value <= 0xdf_ff)
  ) {
    return fallback
  }
  return String.fromCodePoint(value)
}

function parseWebFetchInput(
  input: unknown,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly message: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).url !== "string"
  ) {
    return { ok: false, message: "web_fetch url must be a string." }
  }
  const raw = (input as Record<string, unknown>).url as string
  if (raw.length === 0 || raw.length > MAX_URL_CHARACTERS) {
    return {
      ok: false,
      message: `web_fetch url must be 1-${MAX_URL_CHARACTERS} characters.`,
    }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: `web_fetch could not parse the URL: ${raw}` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: `web_fetch only supports http(s) URLs, got "${url.protocol}".`,
    }
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message: "web_fetch does not accept URLs with embedded credentials.",
    }
  }
  return { ok: true, url: upgradeToHttps(url) }
}

// Plain http is upgraded to https, except for loopback: local dev servers
// speak http and would break.
function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:" || isLoopback(url)) return url
  const upgraded = new URL(url.href)
  upgraded.protocol = "https:"
  return upgraded
}

function isLoopback(url: URL): boolean {
  const { hostname } = url
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  )
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: `${code}: ${message}`,
  }
}
