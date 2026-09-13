import {
  Archive,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { sessionListKey, useAppStore } from "../store/app-store.ts"
import { SidebarDialog, SidebarMenu } from "./sidebar-surfaces.tsx"
import { SidebarNameDialog } from "./sidebar-name-dialog.tsx"
import { SessionItems } from "./sidebar-sessions.tsx"
import { Collapsible, CollapsibleContent } from "./ui/collapsible.tsx"
import { Button } from "./ui/button.tsx"

export function SidebarGroups({
  pinnedProjects,
}: Readonly<{ pinnedProjects: readonly ReactNode[] }>) {
  const sections = useAppStore((state) => state.sidebar.sections)
  return (
    <>
      <SidebarGroup id="pinned" name="Pinned">
        {pinnedProjects}
      </SidebarGroup>
      {sections.map((section) => (
        <SidebarGroup key={section.id} {...section} />
      ))}
    </>
  )
}

export function SidebarOptions() {
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const [creating, setCreating] = useState(false)
  const [archives, setArchives] = useState(false)
  return (
    <>
      <SidebarMenu
        label="Sidebar options"
        triggerContent={
          <>
            <span>Yakitori</span>
            <ChevronDown size={12} />
          </>
        }
        items={[
          {
            label: "New section",
            icon: <FolderPlus size={15} />,
            action: () => setCreating(true),
          },
          {
            label: "Archived conversations",
            icon: <Archive size={15} />,
            action: () => {
              setArchives(true)
              void loadSessions(undefined, { archived: true })
            },
          },
        ]}
      >
        {null}
      </SidebarMenu>
      {creating && (
        <SidebarNameDialog
          title="New section"
          onClose={() => setCreating(false)}
          onSave={(name) => changeSidebar({ type: "create-section", name })}
        />
      )}
      {archives && (
        <SidebarDialog
          title="Archived conversations"
          onClose={() => setArchives(false)}
        >
          <div className="max-h-[55vh] overflow-y-auto">
            <SessionItems archived onSelect={() => setArchives(false)} />
          </div>
        </SidebarDialog>
      )}
    </>
  )
}

function SidebarGroup({
  id,
  name,
  children,
}: Readonly<{ id: string; name: string; children?: ReactNode }>) {
  const open = useAppStore((state) => !state.collapsedSections[id])
  const setSectionOpen = useAppStore((state) => state.setSectionOpen)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const loaded = useAppStore(
    (state) =>
      state.sessionsByProject[sessionListKey(undefined, { sectionId: id })] !==
      undefined,
  )
  const sections = useAppStore((state) => state.sidebar.sections)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const pending = useAppStore((state) =>
    state.inFlightActions.has("sidebar-update"),
  )
  useEffect(() => {
    if ((open || id === "pinned") && !loaded)
      void loadSessions(undefined, { sectionId: id })
  }, [open, loaded, id, loadSessions])
  const empty = useAppStore((state) => {
    const list =
      state.sessionsByProject[sessionListKey(undefined, { sectionId: id })]
    return list !== undefined && !list.error && list.sessions.length === 0
  })
  const index = sections.findIndex((section) => section.id === id)
  const move = (offset: number) => {
    const ids = sections.map((section) => section.id)
    const removed = ids.splice(index, 1)[0]
    if (!removed) return
    ids.splice(index + offset, 0, removed)
    void changeSidebar({ type: "reorder-sections", sectionIds: ids })
  }
  const toggle = (
    <button
      type="button"
      data-sidebar-drag={id === "pinned" ? undefined : "section"}
      data-drag-id={id}
      data-drag-label={name}
      aria-expanded={open}
      className="sidebar-row min-w-0 flex-1 text-muted-foreground"
      onClick={() => {
        setSectionOpen(id, !open)
      }}
    >
      <ChevronRight
        size={14}
        className={`sidebar-chevron ${open ? "rotate-90" : ""}`}
      />
      <span className="truncate text-xs font-medium">{name}</span>
    </button>
  )
  if (
    id === "pinned" &&
    empty &&
    !(Array.isArray(children) && children.length > 0)
  )
    return null
  return (
    <Collapsible
      open={open}
      className="mb-3"
      data-sidebar-layout={`section:${id}`}
    >
      <div
        className="sidebar-project group"
        data-sidebar-drop="section"
        data-drop-id={id}
        data-drop-label={name}
      >
        {id === "pinned" ? (
          toggle
        ) : (
          <SidebarMenu
            label={`Section actions for ${name}`}
            items={[
              {
                label: "Rename section",
                icon: <Pencil size={15} />,
                action: () => setRenaming(true),
              },
              ...(index > 0
                ? [
                    {
                      label: "Move section up",
                      icon: <ChevronUp size={15} />,
                      action: () => move(-1),
                    },
                  ]
                : []),
              ...(index < sections.length - 1
                ? [
                    {
                      label: "Move section down",
                      icon: <ChevronDown size={15} />,
                      action: () => move(1),
                    },
                  ]
                : []),
              {
                label: "Delete section",
                icon: <Trash2 size={15} />,
                destructive: true,
                action: () => setDeleting(true),
              },
            ]}
          >
            {toggle}
          </SidebarMenu>
        )}
      </div>
      <CollapsibleContent className="sidebar-project-content">
        {children}
        <SessionItems sectionId={id} />
      </CollapsibleContent>
      {renaming && (
        <SidebarNameDialog
          title="Rename section"
          initialName={name}
          onClose={() => setRenaming(false)}
          onSave={(name) =>
            changeSidebar({ type: "rename-section", sectionId: id, name })
          }
        />
      )}
      {deleting && (
        <SidebarDialog
          title="Delete section?"
          onClose={() => setDeleting(false)}
        >
          <p className="text-sm text-muted-foreground">
            Conversations return to their project or All sessions.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void changeSidebar({
                  type: "delete-section",
                  sectionId: id,
                }).then((done) => {
                  if (done) setDeleting(false)
                })
              }}
            >
              Delete section
            </Button>
          </div>
        </SidebarDialog>
      )}
    </Collapsible>
  )
}
