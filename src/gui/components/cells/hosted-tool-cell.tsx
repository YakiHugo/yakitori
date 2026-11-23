import { ChevronRight, Cloud, LoaderCircle } from "lucide-react"
import type { HostedToolBlock } from "../../../protocol/hosted-tool.ts"

const toolLabels: Record<HostedToolBlock["kind"], string> = {
  web_search: "Search web",
  web_fetch: "Fetch page",
  file_search: "Search files",
  code_execution: "Run code",
  mcp: "Remote tool",
  image_generation: "Generate image",
  lookup: "Look up information",
}

export function HostedToolCell({ tool }: Readonly<{ tool: HostedToolBlock }>) {
  const Icon = tool.status === "running" ? LoaderCircle : Cloud
  const title = (
    <>
      <Icon
        aria-hidden="true"
        className={
          tool.status === "running"
            ? "size-4 shrink-0 animate-spin"
            : "size-4 shrink-0"
        }
      />
      <span className="min-w-0 truncate">
        {toolLabels[tool.kind]}
        {tool.label ? ` · ${tool.label}` : ""}
      </span>
      <span className="shrink-0 text-caption">Hosted</span>
      {tool.status === "completed" ? null : (
        <span className="shrink-0 text-caption capitalize">{tool.status}</span>
      )}
    </>
  )
  if (!tool.detail)
    return (
      <div className="flex min-w-0 items-center gap-2 text-detail text-muted-foreground">
        {title}
      </div>
    )
  return (
    <details className="group/hosted">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-detail text-muted-foreground hover:text-foreground">
        {title}
        <ChevronRight
          aria-hidden="true"
          className="size-3 shrink-0 group-open/hosted:rotate-90"
        />
      </summary>
      <pre className="tool-output mt-2 max-h-64">{tool.detail}</pre>
    </details>
  )
}
