import { FileText, type LucideIcon, Package } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import type { ApiSkillSummary } from "../../server/protocol.ts"

export type ComposerSuggestion =
  | Readonly<{
      kind: "command"
      name: string
      description: string
      icon: LucideIcon
    }>
  | Readonly<{
      kind: "skill"
      name: string
      description: string
      skill: ApiSkillSummary
    }>
  | Readonly<{
      kind: "file"
      name: string
      description: string
      file: Readonly<{ name: string; path: string }>
    }>

function suggestionKey(item: ComposerSuggestion): string {
  return item.kind === "skill"
    ? item.skill.path
    : item.kind === "file"
      ? item.file.path
      : item.name
}

export function ComposerSuggestions({
  id,
  items,
  activeIndex,
  listLabel,
  error,
  emptyLabel = "No matching commands or skills",
  onHighlight,
  onPick,
}: Readonly<{
  id: string
  items: readonly ComposerSuggestion[]
  activeIndex: number
  listLabel: string
  error: string | undefined
  emptyLabel?: string | undefined
  onHighlight(index: number): void
  onPick(item: ComposerSuggestion): void
}>) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const option = list?.querySelector<HTMLElement>(
      `[id="${id}-${activeIndex}"]`,
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
  }, [activeIndex, id])
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={listLabel}
      className="max-h-[min(19rem,35vh)] overflow-y-auto p-1.5 text-sm"
    >
      <div className="px-3 pt-2 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {listLabel === "Slash commands" ? "Commands" : listLabel}
      </div>
      {items.map((item, index) => (
        <div key={suggestionKey(item)}>
          {item.kind === "skill" &&
          items[index - 1]?.kind !== "skill" &&
          listLabel !== "Skills" ? (
            <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Skills
            </div>
          ) : null}
          <button
            id={`${id}-${index}`}
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
                : item.kind === "file"
                  ? item.file.path
                  : item.description
            }
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${index === activeIndex ? "bg-accent" : "hover:bg-accent/60"}`}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              {item.kind === "skill" ? (
                <Package className="size-4" />
              ) : item.kind === "file" ? (
                <FileText className="size-4" />
              ) : (
                <item.icon className="size-4" />
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="max-w-[50%] shrink-0 truncate font-medium leading-5">
                {item.kind === "command"
                  ? item.name === "/mcp"
                    ? "MCP"
                    : item.name.slice(1, 2).toUpperCase() + item.name.slice(2)
                  : item.name}
              </span>
              <span className="min-w-0 truncate text-sm leading-5 text-muted-foreground">
                {item.description}
              </span>
            </span>
            {item.kind === "skill" ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {item.skill.scope === "repo" ? "Project" : "Personal"}
              </span>
            ) : null}
          </button>
        </div>
      ))}
      {items.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          {error ?? emptyLabel}
        </p>
      ) : null}
      {error && items.length > 0 ? (
        <p role="status" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
