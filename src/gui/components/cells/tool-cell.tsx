import { ChevronRight } from "lucide-react"
import type { CommandResult, ExecutionEntry } from "../../execution-view.ts"
import { cn } from "../../lib/utils.ts"
import { Badge } from "../ui/badge.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"
import { DiffView } from "./diff-view.tsx"

const stateDotClass: Record<string, string> = {
  requested: "bg-amber-500",
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  interrupted: "bg-zinc-400",
}

export function ToolCell({
  entry,
}: {
  readonly entry: Extract<ExecutionEntry, { kind: "tool" }>
}) {
  const isCommand = entry.name === "run_command"
  const command = isCommand ? commandOf(entry.input) : undefined
  return (
    <Collapsible className="rounded-md border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            stateDotClass[entry.state] ?? "bg-zinc-400",
          )}
        />
        <span className="shrink-0 font-medium">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {entry.summary}
        </span>
        <Badge variant={stateBadgeVariant(entry.state)}>{entry.state}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        {isCommand ? (
          <CommandOutput
            command={command ?? entry.summary}
            result={entry.commandResult}
            resultText={entry.resultText}
            errorMessage={entry.resultErrorMessage}
          />
        ) : (
          <>
            {entry.diff !== undefined ? (
              <DiffView diff={entry.diff} />
            ) : (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Input</p>
                <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
                  {JSON.stringify(entry.input, null, 2)}
                </pre>
              </div>
            )}
            {entry.resultText !== undefined && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Output</p>
                <pre
                  className={cn(
                    "overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap",
                    entry.resultError === true && "text-destructive",
                  )}
                >
                  {entry.resultText}
                </pre>
              </div>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
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
      <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-50">
        {`$ ${command}`}
        {resultText === undefined ? "" : `\n${resultText}`}
      </pre>
    )
  }
  const status = [
    result.exitCode === null ? undefined : `exit ${String(result.exitCode)}`,
    result.signal === null ? undefined : `signal ${result.signal}`,
    result.timedOut ? "timed out" : undefined,
    result.truncated ? "truncated" : undefined,
    result.blocked === undefined ? undefined : "blocked",
    result.binary?.stdout === true || result.binary?.stderr === true
      ? "binary"
      : undefined,
    result.durationMs === undefined
      ? undefined
      : formatCommandDuration(result.durationMs),
  ].filter((part) => part !== undefined)
  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 font-mono text-xs leading-5 text-zinc-50 shadow-inner">
      <div className="border-b border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-[11px] text-zinc-500">
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
            className={cn(
              result.blocked === undefined ? "text-red-300" : "text-amber-300",
            )}
          >
            {errorMessage ?? resultText}
          </div>
        ) : null}
        {result.warnings?.map((warning) => (
          <div key={warning} className="text-amber-300/80">
            {`[warning] ${warning}`}
          </div>
        ))}
        {status.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {status.map((part) => (
              <Badge
                key={part}
                variant="outline"
                className={cn(
                  "border-zinc-700 font-mono text-zinc-400",
                  part === "blocked" && "border-amber-700/70 text-amber-300",
                  part === "timed out" && "border-red-800/70 text-red-300",
                )}
              >
                {part}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function formatCommandDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function stateBadgeVariant(
  state: string,
): "secondary" | "destructive" | "outline" {
  if (state === "failed") return "destructive"
  if (state === "requested") return "outline"
  return "secondary"
}

function commandOf(input: unknown): string | undefined {
  if (
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof input.command === "string"
  ) {
    return input.command
  }
  return undefined
}
