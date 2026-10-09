import { FileText, Folder, type LucideIcon, Package } from "lucide-react"
import { useLayoutEffect, useRef } from "react"
import type { ApiSkillSummary } from "../../protocol/application.ts"

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
      file: Readonly<{ name: string; path: string; kind?: "file" | "folder" }>
    }>

function suggestionKey(item: ComposerSuggestion): string {
  return item.kind === "skill"
    ? item.skill.path
    : item.kind === "file"
      ? item.file.path
      : item.name
}

function skillDisplayName(name: string): string {
  return name
    .split("-")
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ")
}

export function ComposerSuggestions({
  id,
  items,
  activeIndex,
  listLabel,
  showHeaders = true,
  error,
  emptyLabel = "No matching commands or skills",
  onHighlight,
  onPick,
}: Readonly<{
  id: string
  items: readonly ComposerSuggestion[]
  activeIndex: number
  listLabel: string
  showHeaders?: boolean
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
      className="composer-suggestions overflow-y-auto p-2 text-[14px]"
    >
      {showHeaders ? (
        <div
          className={`pb-1.5 text-[13px] text-muted-foreground/75 ${listLabel === "Skills" ? "sticky top-0 z-10 -mx-2 bg-popover px-3 pt-2" : "px-2 pt-1"}`}
        >
          {listLabel === "Slash commands" ? "Commands" : listLabel}
        </div>
      ) : null}
      {items.map((item, index) => (
        <div key={suggestionKey(item)}>
          {item.kind === "skill" &&
          items[index - 1]?.kind !== "skill" &&
          listLabel !== "Skills" &&
          showHeaders ? (
            <div className="px-2 pt-2 pb-1.5 text-[13px] text-muted-foreground/75">
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
            className={`flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left transition-colors ${index === activeIndex ? "bg-foreground/[0.055] text-foreground" : "text-foreground/70"}`}
          >
            <span
              aria-hidden="true"
              className={`grid size-4 shrink-0 place-items-center ${index === activeIndex ? "text-foreground" : "text-foreground/65"}`}
            >
              {item.kind === "skill" ? (
                <Package className="size-[14px]" />
              ) : item.kind === "file" && item.file.kind === "folder" ? (
                <Folder className="size-[14px]" />
              ) : item.kind === "file" ? (
                <FileText className="size-[14px]" />
              ) : (
                <item.icon className="size-[14px]" />
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span
                className={`composer-suggestion-label max-w-[75%] shrink-0 truncate leading-5 ${index === activeIndex ? "font-medium" : ""}`}
              >
                {item.kind === "command"
                  ? item.name === "/mcp"
                    ? "MCP"
                    : item.name.slice(1, 2).toUpperCase() + item.name.slice(2)
                  : item.kind === "skill"
                    ? skillDisplayName(item.name)
                    : item.name}
              </span>
              <span className="composer-suggestion-description min-w-0 flex-1 truncate leading-5 text-muted-foreground/65">
                {item.description}
              </span>
            </span>
            {item.kind === "skill" ? (
              <span className="min-w-[3.25rem] shrink-0 text-right text-[13px] leading-5 text-muted-foreground/70">
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
