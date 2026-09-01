import type { RuntimeTool, ToolExecutionResult } from "./types.ts"
import { plainToolName } from "./tool-name.ts"
import { noToolApprovalRequired } from "./approval-requirements.ts"
import {
  completeWebSearchExecution,
  webSearchExecution,
} from "./execution-descriptors.ts"

// Zero-configuration default, mirroring opencode: Exa's anonymous MCP
// endpoint (free tier, no account or handshake — a direct tools/call POST).
// EXA_API_KEY raises the quota; it is sent as a query parameter because that
// is the endpoint's auth mechanism, so the key appears in the request URL
// and in any URL logging. This is an accepted tradeoff.
const DEFAULT_ENDPOINT = "https://mcp.exa.ai/mcp"
const EXA_TOOL_NAME = "web_search_exa"
const NUM_RESULTS = 8
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_QUERY_CHARACTERS = 2_048
// Result digests are small JSON; cap the buffered response so a misbehaving
// endpoint cannot exhaust memory.
const MAX_RESPONSE_BYTES = 1_048_576
const CITATION_REMINDER =
  "Cite the relevant URLs from these results as markdown links when you use them."

export type WebSearchFailureCode =
  | "search_timeout"
  | "aborted"
  | "network_error"
  | "search_error"

export type WebSearchOutcome =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false
      readonly code: WebSearchFailureCode
      readonly message: string
    }

export type WebSearchProvider = (
  query: string,
  signal?: AbortSignal,
) => Promise<WebSearchOutcome>

export type ExaMcpSearchProviderOptions = {
  readonly endpoint?: string
  readonly apiKey?: string
  readonly fetchFn?: typeof fetch
  readonly timeoutMs?: number
}

export function createExaMcpSearchProvider(
  options: ExaMcpSearchProviderOptions = {},
): WebSearchProvider {
  const endpoint = endpointUrl(
    options.endpoint ?? DEFAULT_ENDPOINT,
    options.apiKey ?? process.env.EXA_API_KEY,
  )
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (query, signal) => {
    // One deadline for the whole exchange, including the body read.
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined =
      signal === undefined
        ? timeout.signal
        : AbortSignal.any([timeout.signal, signal])
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: combined,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": "yakitori web_search",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: EXA_TOOL_NAME,
            arguments: { query, numResults: NUM_RESULTS },
          },
        }),
      })
      // Unlike web_fetch, a non-2xx here carries nothing useful for the model.
      if (!response.ok) {
        return {
          ok: false,
          code: "search_error",
          message: `web_search endpoint responded HTTP ${response.status} ${response.statusText}.`,
        }
      }
      return parseMcpBody(await readResponseText(response, MAX_RESPONSE_BYTES))
    } catch (error) {
      if (signal?.aborted) {
        return {
          ok: false,
          code: "aborted",
          message: "web_search was aborted.",
        }
      }
      if (timeout.signal.aborted) {
        return {
          ok: false,
          code: "search_timeout",
          message: `web_search timed out after ${Math.round(timeoutMs / 1_000)}s waiting for the search endpoint.`,
        }
      }
      return {
        ok: false,
        code: "network_error",
        message: `web_search failed to reach the search endpoint: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      const kept = value.subarray(0, value.byteLength - (received - maxBytes))
      if (kept.byteLength > 0) chunks.push(kept)
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export type WebSearchToolOptions = {
  readonly provider?: WebSearchProvider
}

export function createWebSearchTool(
  options: WebSearchToolOptions = {},
): RuntimeTool {
  const provider = options.provider ?? createExaMcpSearchProvider()
  return {
    toolName: plainToolName("web_search"),
    description:
      "Search the web for current information beyond the model's knowledge cutoff. Returns a digest of relevant results with URLs. Include the current year in the query for time-sensitive topics. Follow up with web_fetch to read the full content of a result URL. Read-only.",
    approvalRequirement: noToolApprovalRequired,
    effect: "observe",
    supportsParallelToolCalls: true,
    describeExecution: webSearchExecution,
    completeExecution: completeWebSearchExecution,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_QUERY_CHARACTERS,
          description: "The search query.",
        },
      },
      required: ["query"],
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const parsed = parseWebSearchInput(input)
      if (!parsed.ok) return failure("invalid_tool_input", parsed.message)
      if (context.signal?.aborted) {
        return failure(
          "aborted",
          "web_search was aborted before the request started.",
        )
      }
      const outcome = await provider(parsed.query, context.signal)
      if (!outcome.ok) return failure(outcome.code, outcome.message)
      const content = `${outcome.text}\n\n${CITATION_REMINDER}`
      return {
        ok: true,
        output: {
          query: parsed.query,
          characters: outcome.text.length,
          links: extractLinks(outcome.text),
          content,
        },
        content,
      }
    },
  }
}

function extractLinks(text: string): readonly {
  readonly title: string
  readonly url: string
}[] {
  const links: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/https?:\/\/[^\s)>\]}]+/gu)) {
      const url = match[0].replace(/[.,;:]$/, "")
      if (seen.has(url)) continue
      seen.add(url)
      const before = line.slice(0, match.index).replace(/^\s*\d+[.)]\s*/, "")
      const title = before.replace(/[\s—–:-]+$/, "").trim()
      links.push({ title: title === "" ? url : title, url })
    }
  }
  return links
}

// The endpoint answers either one JSON-RPC document or an SSE stream of
// data: lines carrying JSON-RPC payloads (opencode handles both).
function parseMcpBody(body: string): WebSearchOutcome {
  for (const payload of mcpPayloads(body)) {
    const outcome = interpretPayload(payload)
    if (outcome !== undefined) return outcome
  }
  return {
    ok: false,
    code: "search_error",
    message: "web_search could not parse the search endpoint response.",
  }
}

function mcpPayloads(body: string): unknown[] {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) return [parseJson(trimmed)]
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => parseJson(line.slice("data: ".length)))
}

function interpretPayload(payload: unknown): WebSearchOutcome | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.error)) {
    const detail =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "unknown JSON-RPC error"
    return {
      ok: false,
      code: "search_error",
      message: `web_search endpoint returned a JSON-RPC error: ${detail}`,
    }
  }
  if (!isRecord(payload.result)) return undefined
  const { result } = payload
  const textValue = Array.isArray(result.content)
    ? result.content
        .map((item) => (isRecord(item) ? item.text : undefined))
        .find(
          (value): value is string => typeof value === "string" && value !== "",
        )
    : undefined
  if (result.isError === true) {
    return {
      ok: false,
      code: "search_error",
      message:
        textValue === undefined
          ? "web_search endpoint reported an error."
          : `web_search endpoint reported an error: ${textValue}`,
    }
  }
  return textValue === undefined ? undefined : { ok: true, text: textValue }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function endpointUrl(endpoint: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") return endpoint
  const separator = endpoint.includes("?") ? "&" : "?"
  return `${endpoint}${separator}exaApiKey=${encodeURIComponent(apiKey)}`
}

function parseWebSearchInput(
  input: unknown,
):
  | { readonly ok: true; readonly query: string }
  | { readonly ok: false; readonly message: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>).query !== "string"
  ) {
    return { ok: false, message: "web_search query must be a string." }
  }
  const query = (input as Record<string, unknown>).query as string
  if (query.trim().length === 0 || query.length > MAX_QUERY_CHARACTERS) {
    return {
      ok: false,
      message: `web_search query must be 1-${MAX_QUERY_CHARACTERS} characters.`,
    }
  }
  return { ok: true, query }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(code: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    code,
    message,
    content: `${code}: ${message}`,
  }
}
