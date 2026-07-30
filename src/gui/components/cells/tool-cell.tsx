import { ChevronRight } from "lucide-react"
import type { ExecutionEntry } from "../../execution-view.ts"
import { cn } from "../../lib/utils.ts"
import { Badge } from "../ui/badge.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx"

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
          <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-50">
            {`$ ${command ?? entry.summary}`}
            {entry.resultText === undefined ? "" : `\n${entry.resultText}`}
          </pre>
        ) : (
          <>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Input</p>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
                {JSON.stringify(entry.input, null, 2)}
              </pre>
            </div>
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
