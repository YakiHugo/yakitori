import { CornerDownLeft, Package, Terminal } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import type { ApiSkillSummary } from "../../server/protocol.ts"

export type ComposerSuggestion =
  | Readonly<{ kind: "command"; name: string; description: string }>
  | Readonly<{
      kind: "skill"
      name: string
      description: string
      skill: ApiSkillSummary
    }>

export function ComposerSuggestions({
  items,
  activeIndex,
  skillOnly,
  error,
  onHighlight,
  onPick,
}: Readonly<{
  items: readonly ComposerSuggestion[]
  activeIndex: number
  skillOnly: boolean
  error: string | undefined
  onHighlight(index: number): void
  onPick(item: ComposerSuggestion): void
}>) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const option = list?.querySelector<HTMLElement>(
      `#composer-suggestion-${activeIndex}`,
    )
    if (!list || !option) return
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (
      option.offsetTop + option.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop =
        option.offsetTop + option.offsetHeight - list.clientHeight
    }
  }, [activeIndex])
  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-2xl border bg-popover p-1.5 text-sm shadow-[0_8px_32px_-8px_#0003]">
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {skillOnly ? "Skills" : "Commands & skills"}
      </div>
      <div
        ref={listRef}
        id="composer-suggestions"
        role="listbox"
        aria-label={skillOnly ? "Skills" : "Slash commands"}
        className="relative max-h-72 overflow-y-auto"
      >
        {items.map((item, index) => (
          <button
            key={item.kind === "skill" ? item.skill.path : item.name}
            id={`composer-suggestion-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
            onMouseEnter={() => onHighlight(index)}
            title={
              item.kind === "skill"
                ? `${item.description}\n${item.skill.path}`
                : item.description
            }
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${index === activeIndex ? "bg-accent" : "hover:bg-accent/60"}`}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
              {item.kind === "skill" ? (
                <Package className="size-4" />
              ) : (
                <Terminal className="size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{item.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {item.description}
              </span>
            </span>
            {item.kind === "skill" ? (
              <span className="text-[10px] text-muted-foreground">
                {item.skill.scope === "repo" ? "Project" : "Personal"}
              </span>
            ) : null}
            {index === activeIndex ? (
              <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        ))}
        {items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {error ?? "No matching commands or skills"}
          </p>
        ) : null}
      </div>
      {error && items.length > 0 ? (
        <p role="status" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-1 flex gap-3 border-t px-3 pt-2 pb-1 text-[11px] text-muted-foreground">
        <span>↑ ↓ Navigate</span>
        <span>↵ Select</span>
        <span>Tab Complete</span>
        <span className="ml-auto">Esc Close</span>
      </div>
    </div>
  )
}
