import type { ModelSelection } from "../kernel/index.ts"
import type { ThreadStore } from "../core/thread-store.ts"
import type {
  ModelTarget,
  ModelStreamEvent,
  StreamFn,
} from "../runtime/model.ts"
import type { OperationalFailureReporter } from "./operational-errors.ts"
import {
  consoleOperationalFailureReporter,
  reportOperationalFailure,
} from "./operational-errors.ts"

// Sentence-style titles in the user's language, mirroring the reference
// agents' title generators (Claude Code's Haiku title, Codex thread title).
// Length is tuned to the sidebar's default 352px width: a session row has
// ~276px of text budget at 14px font (30px indent, 8px padding, 14px
// activity spinner, 8px gap, ~16px status icon), which fits 18 CJK or 36
// latin characters. Rows truncate longer titles and the button's native
// title tooltip shows the full text, so this is a target, not a hard layout
// constraint — it also holds at the 480px max width with room to spare.
const TITLE_SYSTEM = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of the user's request. Keep it under 36 half-width characters (18 Chinese characters) so it fits a narrow sidebar. Write it in the same language as the request. Preserve ticket references, file names, and technical terms. Do not answer the request. Do not use quotes, markdown, or trailing punctuation.

Return only a JSON object of the form {"title":"Fix login button on mobile"}.`

const TITLE_INPUT_MAX_CHARS = 2_000
// Half-width display columns: CJK/full-width/emoji count as 2, latin as 1.
const TITLE_MAX_DISPLAY_WIDTH = 36
const TITLE_TIMEOUT_MS = 30_000
const TITLE_MAX_OUTPUT_TOKENS = 128

// Kimi's cheapest coding tier; used for titles whenever that provider is
// registered, regardless of the Session's working model.
export const KIMI_TITLE_MODEL = "kimi-for-coding-highspeed"

export function resolveTitleTarget(
  availableProviders: readonly string[] | undefined,
  modelSelection: ModelSelection | undefined,
): ModelTarget | undefined {
  if (availableProviders?.includes("kimi")) {
    return {
      provider: "kimi",
      model: KIMI_TITLE_MODEL,
      instructionProfileId: KIMI_TITLE_MODEL,
      // Title calls disable thinking entirely: reasoning would burn the small
      // output budget and can leave the response without any text block.
      effort: "off",
    }
  }
  if (modelSelection === undefined || modelSelection.provider === "faux") {
    return undefined
  }
  return {
    provider: modelSelection.provider,
    model: modelSelection.model,
    instructionProfileId: modelSelection.model,
    ...(modelSelection.effort === undefined
      ? {}
      : { effort: modelSelection.effort }),
  }
}

// East Asian wide/fullwidth ranges plus emoji measure two half-width columns;
// everything else measures one. This mirrors how the 14px sidebar row width
// is actually consumed.
const WIDE_CHAR =
  /[\u2E80-\u303F\u3041-\u30FF\u3105-\u312F\u31F0-\u4DBF\u4E00-\u9FFF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}]/u

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1
  return width
}

export function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value
    .trim()
    .replace(/^["'`]+|["'`,.;:。！？!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (trimmed === "") return undefined
  if (displayWidth(trimmed) <= TITLE_MAX_DISPLAY_WIDTH) return trimmed
  // Width-bounded truncation, then back off to the last word boundary so a
  // latin title never ends mid-word (CJK has no spaces to back off to).
  let width = 0
  let cut = 0
  for (const char of trimmed) {
    const next = width + (WIDE_CHAR.test(char) ? 2 : 1)
    if (next > TITLE_MAX_DISPLAY_WIDTH) break
    width = next
    cut += char.length
  }
  let truncated = trimmed.slice(0, cut)
  // Back off to the last word boundary only when the cut clearly landed
  // inside a latin word (CJK has no spaces to back off to).
  const lastSpace = truncated.lastIndexOf(" ")
  const lastChar = truncated[truncated.length - 1] ?? ""
  const nextChar = trimmed[cut] ?? ""
  if (
    lastSpace >= Math.floor(TITLE_MAX_DISPLAY_WIDTH / 3) &&
    /[A-Za-z0-9]/.test(lastChar) &&
    /[A-Za-z0-9]/.test(nextChar)
  ) {
    truncated = truncated.slice(0, lastSpace)
  }
  const result = truncated.replace(/[\s,;:!?。，；：！？]+$/g, "").trim()
  return result === "" ? undefined : result
}

function parseTitleResponse(text: string): string | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  return normalizeSessionTitle((parsed as { title?: unknown }).title)
}

async function streamSessionTitle(
  stream: StreamFn,
  target: ModelTarget,
  text: string,
): Promise<string | undefined> {
  let title: string | undefined
  try {
    const events: AsyncIterable<ModelStreamEvent> = stream({
      target,
      system: [{ id: "session-title", revision: "1", text: TITLE_SYSTEM }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }],
        },
      ],
      tools: [],
      toolWireProtocol: "eager",
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    })
    for await (const event of events) {
      if (event.type === "response") {
        const text = event.response.content.find(
          (block) => block.type === "text",
        )
        title = text === undefined ? undefined : parseTitleResponse(text.text)
      } else if (event.type === "failure" || event.type === "cancelled") {
        return undefined
      }
    }
  } catch {
    return undefined
  }
  return title
}

export type SessionTitleGenerator = {
  // Fire-and-forget naming for a Session's first user input. Resolves the
  // title model, generates a sentence-style title, and stores it as sidebar
  // presentation only while the conversation is still untitled, so a title
  // the user set always wins. Never throws and never blocks the caller.
  generate(input: {
    readonly sessionId: string
    readonly text: string
    readonly modelSelection?: ModelSelection
  }): Promise<void>
}

export function createSessionTitleGenerator(options: {
  readonly stream: StreamFn
  readonly store: ThreadStore
  readonly availableProviders?: readonly string[]
  readonly notifySidebarChanged?: () => void
  readonly reportOperationalFailure?: OperationalFailureReporter
}): SessionTitleGenerator {
  return {
    async generate(input) {
      const untitled = async (): Promise<boolean> => {
        const stored = await options.store.readThread(input.sessionId)
        if (stored?.metadata.title !== undefined) return false
        const presentation = await options.store.sessionPresentation(
          input.sessionId,
        )
        return presentation.title === undefined
      }
      try {
        const text = input.text.trim()
        if (text === "") return
        if (!(await untitled())) return
        const target = resolveTitleTarget(
          options.availableProviders,
          input.modelSelection,
        )
        if (target === undefined) return
        const title = await streamSessionTitle(
          options.stream,
          target,
          [...text].slice(0, TITLE_INPUT_MAX_CHARS).join(""),
        )
        if (title === undefined) return
        // Re-check under the sidebar lock's ordering: a rename admitted while
        // the model call was in flight must not be overwritten.
        if (!(await untitled())) return
        await options.store.updateSessionSidebar({
          type: "session",
          sessionId: input.sessionId,
          title,
        })
        options.notifySidebarChanged?.()
      } catch (error) {
        reportOperationalFailure(
          options.reportOperationalFailure ?? consoleOperationalFailureReporter,
          {
            component: "session-title",
            operation: "generate",
            cause: error,
            sessionId: input.sessionId,
          },
        )
      }
    },
  }
}
