import { Package, Terminal } from "lucide-react"
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
  open,
  items,
  activeIndex,
  skillOnly,
  error,
  onHighlight,
  onPick,
}: Readonly<{
  open: boolean
  items: readonly ComposerSuggestion[]
  activeIndex: number
  skillOnly: boolean
  error: string | undefined
  onHighlight(index: number): void
  onPick(item: ComposerSuggestion): void
}>) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
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
  }, [activeIndex, open])
  return (
    <div
      hidden={!open}
      aria-hidden={!open}
      inert={!open}
      className="composer-suggestion-panel absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-2xl border bg-popover p-1.5 text-sm shadow-[0_8px_32px_-8px_#0003]"
    >
      <div
        ref={listRef}
        id="composer-suggestions"
        role="listbox"
        aria-label={skillOnly ? "Skills" : "Slash commands"}
        className="relative max-h-72 overflow-y-auto"
      >
        {items.map((item, index) => (
          <div key={item.kind === "skill" ? item.skill.path : item.name}>
            {item.kind === "skill" && items[index - 1]?.kind !== "skill" ? (
              <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                Skills
              </div>
            ) : null}
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
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left ${index === activeIndex ? "bg-accent" : "hover:bg-accent/60"}`}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                {item.kind === "skill" ? (
                  <Package className="size-4" />
                ) : (
                  <Terminal className="size-4" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="max-w-[60%] shrink-0 truncate">
                  {item.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {item.description}
                </span>
              </span>
              {item.kind === "skill" ? (
                <span className="text-[10px] text-muted-foreground">
                  {item.skill.scope === "repo" ? "Project" : "Personal"}
                </span>
              ) : null}
            </button>
          </div>
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
    </div>
  )
}
