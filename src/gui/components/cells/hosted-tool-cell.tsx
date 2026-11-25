import { useTranslation } from "../../i18n/use-translation.ts"
import { ChevronRight, Cloud, LoaderCircle } from "lucide-react"
import type { ReactNode } from "react"
import type { HostedToolBlock } from "../../../protocol/hosted-tool.ts"
import type { ExecutionEntry } from "../../execution-view.ts"
import type { Message } from "../../i18n/messages.ts"
import { openUrlTarget } from "../../lib/open-resource.ts"

const toolLabels: Record<HostedToolBlock["kind"], Message> = {
  web_search: "Search web",
  web_fetch: "Fetch page",
  file_search: "Search files",
  code_execution: "Run code",
  mcp: "Remote tool",
  image_generation: "Generate image",
  lookup: "Look up information",
}

export function HostedToolCell({
  entry,
  code,
}: Readonly<{
  entry: Extract<ExecutionEntry, { kind: "hosted_tool" }>
  code?: ReactNode
}>) {
  const { t } = useTranslation()
  const { tool, provider } = entry
  const web = tool.kind === "web_search" || tool.kind === "web_fetch"
  const resultLines = web
    ? [
        ...new Set([
          ...(tool.kind === "web_fetch" &&
          tool.label !== undefined &&
          webUrl(tool.label) !== undefined
            ? [tool.label]
            : []),
          ...(tool.detail
            ?.split("\n")
            .map((line) => line.trim())
            .filter(Boolean) ?? []),
        ]),
      ]
    : []
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
        {t(toolLabels[tool.kind])}
        {tool.label ? ` · ${tool.label}` : ""}
      </span>
      <span className="shrink-0 text-caption">{t("Hosted")}</span>
      {provider === undefined ? null : (
        <span className="min-w-0 truncate text-caption">{provider}</span>
      )}
      {tool.status === "completed" ? null : (
        <span className="shrink-0 text-caption capitalize">{tool.status}</span>
      )}
    </>
  )
  if (!tool.detail && tool.sourceCode === undefined && resultLines.length === 0)
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
      {tool.sourceCode === undefined
        ? null
        : (code ?? (
            <pre className="tool-output mt-2 max-h-64">{tool.sourceCode}</pre>
          ))}
      {resultLines.length > 0 ? (
        <ul
          className="mt-2 max-h-64 space-y-1 overflow-auto text-detail"
          aria-label={t("Hosted web results")}
        >
          {resultLines.map((line) => {
            const url = webUrl(line)
            return (
              <li key={line} className="break-all">
                {url === undefined ? (
                  line
                ) : (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                    onClick={(event) => {
                      if (window.yakitoriDesktop === undefined) return
                      event.preventDefault()
                      void openUrlTarget({ kind: "url", url })
                    }}
                  >
                    {line}
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      ) : tool.detail ? (
        <pre className="tool-output mt-2 max-h-64">{tool.detail}</pre>
      ) : null}
    </details>
  )
}

function webUrl(text: string): string | undefined {
  if (/\s/u.test(text)) return undefined
  const url = URL.parse(text)
  return url !== null &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password
    ? url.href
    : undefined
}
