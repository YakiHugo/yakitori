import {
  Files,
  GitCompareArrows,
  Globe,
  MessageCirclePlus,
  Monitor,
  Plus,
  Users,
} from "lucide-react"
import type { WorkspaceTab, WorkspaceView } from "../store/workspace-store.ts"

export const workspaceViews = {
  changes: { label: "Changes", icon: GitCompareArrows, needsProject: true },
  files: { label: "Files", icon: Files, needsProject: true },
  browser: { label: "Browser", icon: Globe },
  computer: { label: "Computer", icon: Monitor, nativeOnly: true },
  chat: { label: "Side chat", icon: MessageCirclePlus, nativeOnly: true },
  agents: { label: "Subagents", icon: Users, nativeOnly: true },
} satisfies Record<
  WorkspaceView,
  {
    label: string
    icon: typeof Files
    needsProject?: boolean
    nativeOnly?: boolean
  }
>

export function workspaceTabPresentation(tab: WorkspaceTab) {
  if (tab.kind === "launcher") return { label: "New tab", icon: Plus }
  if (tab.kind === "skill")
    return { label: tab.name, icon: Files, title: tab.path }
  if (tab.kind === "file")
    return {
      label: tab.path.split("/").at(-1) ?? tab.path,
      icon: Files,
      title: tab.path,
    }
  const { label, icon } = workspaceViews[tab.kind]
  return {
    label:
      (tab.kind === "browser" || tab.kind === "chat") && tab.title
        ? tab.title
        : label,
    icon,
  }
}
