import {
  Files,
  GitCompareArrows,
  Globe,
  MessageCirclePlus,
  Monitor,
  Plus,
  Users,
} from "lucide-react"
import type { Message, Translate } from "../i18n/messages.ts"
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
    label: Message
    icon: typeof Files
    needsProject?: boolean
    nativeOnly?: boolean
  }
>

export function workspaceTabPresentation(tab: WorkspaceTab, t: Translate) {
  if (tab.kind === "launcher") return { label: t("New tab"), icon: Plus }
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
        : t(label),
    icon,
  }
}
