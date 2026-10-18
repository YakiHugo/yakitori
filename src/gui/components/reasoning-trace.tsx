import type { ExecutionEntry } from "../execution-view.ts"
import { LiveTextNotice } from "./cells/live-text-notice.tsx"
import { MarkdownView } from "./markdown.tsx"

export function reasoningSections(text: string): {
  line: number
  summary?: string
  body: string
}[] {
  const sections: { line: number; summary?: string; body: string }[] = []
  let current: { line: number; summary?: string; body: string } = {
    line: 0,
    body: "",
  }
  let fence: string | undefined
  const lines = text.trim().split("\n")
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    const insideFence = fence !== undefined
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined
    }
    const heading =
      insideFence || marker
        ? undefined
        : /^(?:\*\*(.+?)\*\*|#{1,6}[ \t]+(.+?))[ \t]*$/.exec(trimmed)
    // OpenAI can deliver several summary parts in one reasoning item. Keep
    // each title separate, including the unfinished final streaming title.
    const summary =
      heading?.[1] ??
      heading?.[2]?.replace(/[ \t]+#+$/, "") ??
      (!insideFence && index === lines.length - 1
        ? /^\*\*([^*]*)$/.exec(trimmed)?.[1]
        : undefined)
    if (summary !== undefined) {
      if (current.summary || current.body.trim()) sections.push(current)
      current = {
        line: index,
        summary: summary.replace(/\*\*|__|`/g, "").trim(),
        body: "",
      }
    } else current.body += `${line}\n`
  }
  if (current.summary || current.body.trim()) sections.push(current)
  return sections
}

export function ReasoningTrace({
  entries,
  active,
  workspaceRoot,
  apiBase,
}: Readonly<{
  entries: readonly Extract<ExecutionEntry, { kind: "reasoning" }>[]
  active: boolean
  workspaceRoot: string | undefined
  apiBase?: string | undefined
}>) {
  return (
    <div className="flex flex-col gap-3 text-detail text-muted-foreground">
      {entries.map((entry) => {
        const sections = reasoningSections(entry.text).filter((section) =>
          section.body.trim(),
        )
        if (sections.length === 0 && !entry.incomplete) return null
        return (
          <div key={entry.itemId} className="flex flex-col gap-2">
            <LiveTextNotice entry={entry} />
            {sections.map(({ line, body }) => (
              <MarkdownView
                key={line}
                text={body}
                streaming={active && entry.status === "streaming"}
                className="markdown-compact max-w-2xl text-muted-foreground"
                workspaceRoot={workspaceRoot}
                apiBase={apiBase}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
