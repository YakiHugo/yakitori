import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolModelContent,
  ToolOutputBudget,
  ToolResultPresentation,
} from "./types.ts"

export function fitText(text: string, budget: ToolOutputBudget): string {
  const lines = text
    .split("\n")
    .slice(0, Math.max(0, budget.maxLines))
    .join("\n")
  const bytes = Buffer.from(lines)
  if (bytes.length <= budget.maxBytes) return lines
  let end = Math.max(0, budget.maxBytes)
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

// Reserve the control envelope before allocating any space to the body.
export function textPreview(
  text: string,
  budget: ToolOutputBudget,
  notice: string,
): string {
  if (fitText(text, budget) === text) return text
  if (fitText(notice, budget) !== notice)
    throw new Error("Tool output budget cannot fit its recovery metadata.")
  const preview = fitText(text, {
    maxBytes: budget.maxBytes - Buffer.byteLength(notice) - 1,
    maxLines: budget.maxLines - notice.split("\n").length,
  })
  return preview === "" ? notice : `${notice}\n${preview}`
}

export function mediaPresentation(
  content: ToolModelContent,
): ToolResultPresentation {
  return {
    toModelContent: (budget) => ({
      ...content,
      content: textPreview(
        content.content,
        budget,
        "[Tool text truncated; media retained.]",
      ),
    }),
  }
}

export async function finalizeToolOutput(
  result: ToolExecutionResult,
  budget: ToolOutputBudget,
  context: ToolExecutionContext,
  fileName = "result.txt",
): Promise<ToolModelContent> {
  if (result.presentation !== undefined) {
    const projected = await result.presentation.toModelContent(budget)
    if (fitText(projected.content, budget) !== projected.content)
      throw new Error("Tool result exceeded its declared output budget.")
    return {
      ...projected,
      toolContentTruncated:
        projected.toolContentTruncated ?? projected.content !== result.content,
    }
  }
  if (fitText(result.content, budget) === result.content)
    return { content: result.content, toolContentTruncated: false }
  const saved =
    context.rolloutAssets !== undefined &&
    context.rolloutId !== undefined &&
    context.toolCallId !== undefined
      ? await context.rolloutAssets.saveToolFile(
          context.rolloutId,
          context.toolCallId,
          fileName,
          Buffer.from(result.content),
        )
      : undefined
  const notice =
    saved === undefined
      ? "[Output truncated. Full output unavailable: no rollout asset storage.]"
      : `[Output truncated. Full text saved to ${saved.path}. Use read_file with offset and limit, or a bounded command for long lines.]`
  return {
    content: textPreview(result.content, budget, notice),
    toolContentTruncated: true,
  }
}

export function headTailPreview(
  text: string,
  budget: ToolOutputBudget,
): string {
  if (fitText(text, budget) === text) return text
  const notice = "[Command preview truncated.]"
  if (fitText(notice, budget) !== notice) return fitText(notice, budget)
  const bytes = Math.max(0, budget.maxBytes - Buffer.byteLength(notice) - 2)
  const lines = Math.max(0, budget.maxLines - 1)
  const head = fitText(text, {
    maxBytes: Math.floor(bytes * 0.3),
    maxLines: Math.floor(lines * 0.3),
  })
  const tailLines = text
    .split("\n")
    .slice(-Math.max(1, lines - Math.floor(lines * 0.3)))
    .join("\n")
  const tailBytes = Buffer.from(tailLines)
  let start = Math.max(0, tailBytes.length - (bytes - Math.floor(bytes * 0.3)))
  while (start < tailBytes.length && ((tailBytes[start] ?? 0) & 0xc0) === 0x80)
    start++
  const tail = lines === 0 ? "" : tailBytes.subarray(start).toString("utf8")
  return [head, notice, tail].filter((part) => part !== "").join("\n")
}
