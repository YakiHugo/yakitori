// Shared HTTP/SSE framing for Gemini's two native APIs. Semantic events stay
// in their protocol adapters.
export class GeminiProtocolError extends Error {}
export class GeminiIncompleteStreamError extends Error {}

export async function readGeminiError(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      // Implementation safety boundary: error bodies are diagnostic payloads,
      // not generated output. Bound allocation before parsing untrusted JSON.
      if (bytes > 64 * 1024) {
        await reader.cancel()
        return undefined
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function* geminiSse(
  body: ReadableStream<Uint8Array>,
  doneSentinel = false,
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  let data: string[] = []
  // Local memory-safety boundary for malformed/unbounded SSE events, not a
  // Gemini product quota. This adapter only requests text and tool arguments.
  const maxEventCharacters = 16 * 1024 * 1024
  let eventCharacters = 0
  try {
    while (true) {
      const next = await reader.read()
      buffer += next.done
        ? decoder.decode()
        : decoder.decode(next.value, { stream: true })
      if (buffer.length + eventCharacters > maxEventCharacters)
        throw new GeminiProtocolError(
          "Gemini SSE event exceeds safety boundary.",
        )
      while (true) {
        const end = buffer.search(/[\r\n]/)
        if (end === -1) break
        if (buffer[end] === "\r" && end === buffer.length - 1 && !next.done)
          break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(
          end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1),
        )
        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n")
            yield doneSentinel && payload === "[DONE]"
              ? payload
              : JSON.parse(payload)
          }
          data = []
          eventCharacters = 0
        } else if (line === "data" || line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "")
          data.push(value)
          eventCharacters += value.length
          if (eventCharacters > maxEventCharacters)
            throw new GeminiProtocolError(
              "Gemini SSE event exceeds safety boundary.",
            )
        }
      }
      if (next.done) {
        if (buffer.trim() !== "" || data.length > 0)
          throw new GeminiIncompleteStreamError("Truncated Gemini SSE event.")
        return
      }
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
