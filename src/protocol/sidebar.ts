export type SessionPresentation = Readonly<{
  title?: string
  archived?: boolean
  sectionId?: string
  sectionPosition?: number
}>

export type SidebarSection = Readonly<{ id: string; name: string }>

export type SessionSidebar = Readonly<{
  sections: readonly SidebarSection[]
  entries: Readonly<Record<string, SessionPresentation>>
}>

export type SidebarChange =
  | Readonly<{
      type: "session"
      sessionId: string
      title?: string
      archived?: boolean
      sectionId?: string | null
    }>
  | Readonly<{
      type: "move-session"
      sessionId: string
      sectionId: string | null
      beforeSessionId?: string
    }>
  | Readonly<{ type: "create-section"; name: string }>
  | Readonly<{ type: "rename-section"; sectionId: string; name: string }>
  | Readonly<{ type: "delete-section"; sectionId: string }>
  | Readonly<{ type: "reorder-sections"; sectionIds: readonly string[] }>
