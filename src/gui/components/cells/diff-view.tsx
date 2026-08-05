import type { ToolDiff } from "../../execution-view.ts"
import { Badge } from "../ui/badge.tsx"

export function DiffView({ diff }: { readonly diff: ToolDiff }) {
  return (
    <div>
      {diff.truncated && (
        <Badge variant="outline" className="mb-1">
          diff truncated
        </Badge>
      )}
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-5">
        {diff.text.split("\n").map((line, index) => (
          // Static text lines never reorder, so the line number is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are position-stable
          <div key={index} className={diffLineClass(line)}>
            {line}
          </div>
        ))}
      </pre>
    </div>
  )
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("---") || line.startsWith("+++")) {
    return "text-muted-foreground"
  }
  if (line.startsWith("+")) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  }
  if (line.startsWith("-")) {
    return "bg-red-500/10 text-red-700 dark:text-red-400"
  }
  if (line.startsWith("@@")) {
    return "text-muted-foreground"
  }
  return undefined
}
