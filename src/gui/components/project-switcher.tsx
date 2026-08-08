import { Check, FolderOpen } from "lucide-react"
import { useState } from "react"
import { cn } from "../lib/utils.ts"
import { useAppStore } from "../store/app-store.ts"
import { Button } from "./ui/button.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx"

export function ProjectSwitcher() {
  const projects = useAppStore((state) => state.projects)
  const currentProject = useAppStore((state) => state.currentProject)
  const busy = useAppStore((state) => state.busy)
  const selectProject = useAppStore((state) => state.selectProject)
  const addProject = useAppStore((state) => state.addProject)
  const [draft, setDraft] = useState("")

  // Servers without the projects route never populate project state.
  if (projects.length === 0 && currentProject === undefined) return null

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          title={currentProject}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
        >
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {currentProject === undefined
              ? "Select project"
              : basename(currentProject)}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {projects.map((path) => (
            <button
              key={path}
              type="button"
              title={path}
              onClick={() => void selectProject(path)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                path === currentProject && "bg-accent",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {path}
              </span>
              {path === currentProject && <Check className="size-4 shrink-0" />}
            </button>
          ))}
          <form
            className="flex items-center gap-2 px-2 pt-1"
            onSubmit={(event) => {
              event.preventDefault()
              const path = draft.trim()
              if (path === "") return
              setDraft("")
              void addProject(path)
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Add project (absolute path)"
              aria-label="Add project"
              className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={busy || draft.trim() === ""}
            >
              Add
            </Button>
          </form>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}
