import { ExternalLink } from "lucide-react"
import { useState } from "react"
import type { CommandResult } from "../../execution-view.ts"
import {
  fileActionLabel,
  openFileTarget,
  openUrlTarget,
} from "../../lib/open-resource.ts"
import { cn } from "../../lib/utils.ts"
import type { FileTarget, ToolDetail } from "../../tool-presentation.ts"
import { DiffView } from "./diff-view.tsx"

export function ToolDetailView({
  detail,
  workspaceRoot,
  onOpenSession,
}: {
  readonly detail?: ToolDetail | undefined
  readonly workspaceRoot?: string | undefined
  readonly onOpenSession?: ((sessionId: string) => Promise<void>) | undefined
}) {
  if (detail === undefined) {
    return (
      <p className="text-xs text-muted-foreground">Waiting for a result…</p>
    )
  }
  switch (detail.kind) {
    case "file_excerpt":
      return (
        <div className="space-y-2">
          <FileLink
            target={{
              kind: "file",
              path: detail.path,
              ...(detail.startLine === undefined
                ? {}
                : { line: detail.startLine }),
            }}
            workspaceRoot={workspaceRoot}
          />
          {detail.truncated ? (
            <p className="text-[11px] text-muted-foreground">
              Partial file view
            </p>
          ) : null}
          <pre className="max-h-96 overflow-auto rounded-sm bg-background/55 px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">
            {detail.content}
          </pre>
        </div>
      )
    case "file_matches":
      return (
        <div className="space-y-3">
          {detail.groups.map((group) => (
            <div key={group.path} className="space-y-1">
              <FileLink
                target={{ kind: "file", path: group.path }}
                workspaceRoot={workspaceRoot}
              />
              <div className="space-y-0.5 font-mono text-xs">
                {group.matches.map((match) => (
                  <FileMatchRow
                    key={`${match.line ?? "line"}:${match.text ?? ""}`}
                    path={group.path}
                    line={match.line}
                    text={match.text}
                    workspaceRoot={workspaceRoot}
                  />
                ))}
              </div>
            </div>
          ))}
          {detail.truncated ? (
            <p className="text-[11px] text-muted-foreground">Partial results</p>
          ) : null}
        </div>
      )
    case "file_list":
      return (
        <div className="space-y-0.5">
          {detail.paths.map((path) => (
            <FileLink
              key={path}
              target={{ kind: "file", path }}
              workspaceRoot={workspaceRoot}
            />
          ))}
          {detail.truncated ? (
            <p className="pt-1 text-[11px] text-muted-foreground">
              Partial results
            </p>
          ) : null}
        </div>
      )
    case "diff":
      return (
        <div className="space-y-2">
          {detail.path === undefined ? null : (
            <FileLink
              target={{ kind: "file", path: detail.path }}
              workspaceRoot={workspaceRoot}
            />
          )}
          <DiffView diff={detail.diff} />
        </div>
      )
    case "command":
      return (
        <CommandOutput
          command={detail.command}
          result={detail.result}
          resultText={detail.resultText}
          errorMessage={detail.errorMessage}
        />
      )
    case "links":
      return detail.links.length === 0 ? (
        <TextOutput text={detail.fallbackText ?? "No links returned."} />
      ) : (
        <div className="space-y-2">
          {detail.links.map((link) => (
            <UrlLink key={link.url} title={link.title} url={link.url} />
          ))}
        </div>
      )
    case "collaboration":
      return (
        <div className="space-y-2">
          {detail.text === undefined ? null : <TextOutput text={detail.text} />}
          {detail.sessionId === undefined ||
          onOpenSession === undefined ? null : (
            <ActionButton
              label="Open child task"
              action={() => onOpenSession(detail.sessionId as string)}
            />
          )}
        </div>
      )
    case "text":
      return <TextOutput text={detail.text} />
  }
}

function FileLink({
  target,
  workspaceRoot,
}: {
  readonly target: FileTarget
  readonly workspaceRoot?: string | undefined
}) {
  return (
    <ActionButton
      label={target.path}
      title={fileActionLabel()}
      mono
      action={() => openFileTarget(target, workspaceRoot)}
    />
  )
}

function FileMatchRow({
  path,
  line,
  text,
  workspaceRoot,
}: {
  readonly path: string
  readonly line?: number | undefined
  readonly text?: string | undefined
  readonly workspaceRoot?: string | undefined
}) {
  return (
    <ActionButton
      label={text ?? ""}
      title={fileActionLabel()}
      mono
      mutedPrefix={line === undefined ? undefined : String(line)}
      action={() =>
        openFileTarget(
          { kind: "file", path, ...(line === undefined ? {} : { line }) },
          workspaceRoot,
        )
      }
    />
  )
}

function UrlLink({
  title,
  url,
}: {
  readonly title: string
  readonly url: string
}) {
  return (
    <ActionButton
      label={title}
      secondary={displayUrl(url)}
      title="Open in browser"
      action={() => openUrlTarget({ kind: "url", url })}
    />
  )
}

function ActionButton({
  label,
  secondary,
  title,
  mono = false,
  mutedPrefix,
  action,
}: {
  readonly label: string
  readonly secondary?: string | undefined
  readonly title?: string | undefined
  readonly mono?: boolean | undefined
  readonly mutedPrefix?: string | undefined
  readonly action: () => Promise<void>
}) {
  const [error, setError] = useState<string>()
  return (
    <button
      type="button"
      title={error ?? title}
      className={cn(
        "group/action flex w-full min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-xs outline-none hover:bg-background/65 focus-visible:bg-background/80",
        mono && "font-mono",
        error !== undefined && "text-destructive",
      )}
      onClick={() => {
        setError(undefined)
        void action().catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "Could not open")
        })
      }}
    >
      {mutedPrefix === undefined ? null : (
        <span className="w-8 shrink-0 text-right text-muted-foreground">
          {mutedPrefix}
        </span>
      )}
      <span className="min-w-0 truncate text-foreground/85 group-hover/action:text-foreground">
        {error ?? label}
      </span>
      {secondary === undefined ? null : (
        <span className="ml-auto hidden shrink-0 text-muted-foreground sm:inline">
          {secondary}
        </span>
      )}
      <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground opacity-0 group-hover/action:opacity-100 group-focus-visible/action:opacity-100" />
    </button>
  )
}

function TextOutput({ text }: { readonly text: string }) {
  return (
    <pre className="max-h-96 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap text-foreground/85">
      {text}
    </pre>
  )
}

function CommandOutput({
  command,
  result,
  resultText,
  errorMessage,
}: {
  readonly command: string
  readonly result?: CommandResult | undefined
  readonly resultText?: string | undefined
  readonly errorMessage?: string | undefined
}) {
  if (result === undefined) {
    return (
      <pre className="overflow-x-auto rounded-sm bg-zinc-950 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-50">
        {`$ ${command}`}
        {resultText === undefined ? "" : `\n${resultText}`}
      </pre>
    )
  }
  const status = [
    result.exitCode === null ? undefined : `exit ${String(result.exitCode)}`,
    result.signal === null ? undefined : `signal ${result.signal}`,
    result.timedOut ? "timed out" : undefined,
    result.truncated ? "partial" : undefined,
    result.blocked === undefined ? undefined : "blocked",
    result.binary?.stdout === true || result.binary?.stderr === true
      ? "binary"
      : undefined,
    result.durationMs === undefined
      ? undefined
      : formatDuration(result.durationMs),
  ].filter((part): part is string => part !== undefined)
  return (
    <div className="overflow-hidden rounded-sm bg-zinc-950 font-mono text-xs leading-5 text-zinc-50 shadow-inner">
      <div className="bg-zinc-900/80 px-3 py-1.5 text-[11px] text-zinc-500">
        {result.cwd === undefined ? "workspace" : result.cwd}
      </div>
      <div className="overflow-x-auto p-3 whitespace-pre-wrap">
        <div className="text-zinc-100">{`$ ${command}`}</div>
        {result.stdout.length > 0 ? <div>{result.stdout}</div> : null}
        {result.stderr.length > 0 ? (
          <div className="text-zinc-400">{`[stderr]\n${result.stderr}`}</div>
        ) : null}
        {(errorMessage ??
          (result.blocked === undefined ? undefined : resultText)) !==
        undefined ? (
          <div
            className={
              result.blocked === undefined ? "text-red-300" : "text-amber-300"
            }
          >
            {errorMessage ?? resultText}
          </div>
        ) : null}
        {result.warnings?.map((warning) => (
          <div key={warning} className="text-amber-300/80">
            {`[warning] ${warning}`}
          </div>
        ))}
        {status.length === 0 ? null : (
          <div className="mt-2 text-[11px] text-zinc-500">
            {status.join(" · ")}
          </div>
        )}
      </div>
    </div>
  )
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.hostname
  } catch {
    return value
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}
