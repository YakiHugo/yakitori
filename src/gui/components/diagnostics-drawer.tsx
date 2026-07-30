import { ChevronRight } from "lucide-react"
import { formatTime } from "../lib/format.ts"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { Badge } from "./ui/badge.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

export function DiagnosticsDrawer() {
  const events = useAppStore((state) => state.events)
  const streamStatus = useAppStore((state) => state.streamStatus)

  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:bg-accent/50">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        <span>Diagnostics</span>
        <Badge variant="secondary">{events.length} events</Badge>
        <Badge variant={streamBadgeVariant(streamStatus)}>{streamStatus}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="h-56 border-t">
          <div className="flex flex-col gap-2 p-3">
            {[...events].reverse().map((event) => (
              <article key={event.id} className="rounded-md border bg-card p-2">
                <header className="flex items-center justify-between gap-2">
                  <span
                    className={cn("text-xs font-medium", eventTone(event.type))}
                  >
                    {event.type}
                  </span>
                  <time className="text-xs text-muted-foreground">
                    {formatTime(event.createdAt)}
                  </time>
                </header>
                <pre className="mt-1 overflow-x-auto text-xs text-muted-foreground">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </article>
            ))}
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}

function streamBadgeVariant(
  status: "connected" | "connecting" | "disconnected" | "idle",
): "secondary" | "destructive" | "outline" {
  if (status === "connected") return "secondary"
  if (status === "disconnected") return "destructive"
  return "outline"
}

function eventTone(type: string): string {
  if (type.includes("failed") || type.includes("cancelled")) {
    return "text-destructive"
  }
  if (type.includes("interrupted")) return "text-muted-foreground"
  if (type.includes("created") || type.includes("admitted")) {
    return "text-emerald-600"
  }
  if (type.includes("completed") || type.includes("resolved")) {
    return "text-sky-600"
  }
  return "text-muted-foreground"
}
