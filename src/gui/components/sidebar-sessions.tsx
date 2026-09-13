import {
  ArrowUp,
  ArrowDown,
  Archive,
  ArchiveRestore,
  GitFork,
  Pencil,
  Pin,
  FolderInput,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import type { ApiSessionSummary } from "../../server/protocol.ts"
import {
  sessionListKey,
  useAppStore,
  type SidebarListFilter,
} from "../store/app-store.ts"
import { SidebarDialog, SidebarMenu } from "./sidebar-surfaces.tsx"
import { SidebarNameDialog } from "./sidebar-name-dialog.tsx"
import { Button } from "./ui/button.tsx"

export function SessionItems({
  projectId,
  sectionId,
  archived,
  onSelect,
}: Readonly<{ projectId?: string | undefined; onSelect?(): void }> &
  SidebarListFilter) {
  const filter = {
    ...(sectionId === undefined ? {} : { sectionId }),
    ...(archived === undefined ? {} : { archived }),
  }
  const list = useAppStore(
    (state) => state.sessionsByProject[sessionListKey(projectId, filter)],
  )
  const selectedId = useAppStore((state) => state.selection.sessionId)
  const selectSession = useAppStore((state) => state.selectSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const inFlight = useAppStore((state) => state.inFlightActions)
  const changeSidebar = useAppStore((state) => state.changeSidebar)
  const sections = useAppStore((state) => state.sidebar.sections)
  const [renaming, setRenaming] = useState<ApiSessionSummary>()
  const [pendingDeleteId, setPendingDeleteId] = useState<string>()
  const sessions = list?.sessions ?? []
  const [visibleCount, setVisibleCount] = useState(5)
  // The reference shows five recent rows per project, with an explicit reveal.
  // This is a display window; the selected conversation stays visible.
  const shownCount =
    projectId && !archived
      ? Math.max(
          visibleCount,
          sessions.findIndex((session) => session.id === selectedId) + 1,
        )
      : sessions.length
  const visibleSessions = sessions.slice(0, shownCount)
  const hasHiddenRows = visibleSessions.length < sessions.length
  return (
    <>
      {visibleSessions.map((session, index) => (
        <div
          key={session.navigationId ?? session.id}
          className="sidebar-session group"
          data-sidebar-layout={`session:${sessionListKey(projectId, filter)}:${session.navigationId ?? session.id}`}
          data-sidebar-drop={archived ? undefined : "session"}
          data-drop-id={session.id}
          data-drop-section={sectionId}
          data-drop-label={session.title ?? "Untitled session"}
          data-selected={session.id === selectedId}
        >
          <SidebarMenu
            label={`Session actions for ${session.title ?? "Untitled session"}`}
            items={[
              ...(sectionId && index > 0
                ? [
                    {
                      label: "Move up",
                      icon: <ArrowUp size={15} />,
                      action: () =>
                        void changeSidebar({
                          type: "move-session",
                          sessionId: session.id,
                          sectionId,
                          beforeSessionId: sessions[index - 1]?.id as string,
                        }),
                    },
                  ]
                : []),
              ...(sectionId &&
              index < sessions.length - 1 &&
              (index < sessions.length - 2 || !list?.nextCursor)
                ? [
                    {
                      label: "Move down",
                      icon: <ArrowDown size={15} />,
                      action: () =>
                        void changeSidebar({
                          type: "move-session",
                          sessionId: session.id,
                          sectionId,
                          ...(sessions[index + 2] === undefined
                            ? {}
                            : {
                                beforeSessionId: sessions[index + 2]
                                  ?.id as string,
                              }),
                        }),
                    },
                  ]
                : []),
              {
                label: session.sectionId === "pinned" ? "Unpin" : "Pin",
                icon: <Pin size={15} />,
                action: () =>
                  void changeSidebar({
                    type: "session",
                    sessionId: session.id,
                    sectionId: session.sectionId === "pinned" ? null : "pinned",
                  }),
              },
              {
                label: "Rename",
                icon: <Pencil size={15} />,
                action: () => setRenaming(session),
              },
              {
                label: "Move to section",
                icon: <FolderInput size={15} />,
                items: [
                  { id: "", name: "Projects / All sessions" },
                  { id: "pinned", name: "Pinned" },
                  ...sections,
                ].map((section) => ({
                  label: section.name,
                  checked: (session.sectionId ?? "") === section.id,
                  action: () =>
                    void changeSidebar({
                      type: "session",
                      sessionId: session.id,
                      sectionId: section.id || null,
                    }),
                })),
              },
              {
                separatorBefore: true,
                label: session.archived
                  ? "Restore conversation"
                  : "Archive conversation",
                icon: session.archived ? (
                  <ArchiveRestore size={15} />
                ) : (
                  <Archive size={15} />
                ),
                action: () =>
                  void changeSidebar({
                    type: "session",
                    sessionId: session.id,
                    archived: !session.archived,
                  }),
              },
              {
                label: "Delete conversation",
                icon: <Trash2 size={15} />,
                destructive: true,
                action: () => setPendingDeleteId(session.id),
              },
            ]}
          >
            <button
              type="button"
              data-sidebar-drag={archived ? undefined : "session"}
              data-drag-id={session.id}
              data-drag-label={session.title ?? "Untitled session"}
              data-drag-project={session.projectId}
              aria-current={session.id === selectedId}
              title={session.title ?? "Untitled session"}
              onClick={() => {
                onSelect?.()
                void selectSession(session.id, session)
              }}
              className="sidebar-row min-w-0 flex-1 pl-8"
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {session.title ?? "Untitled session"}
              </span>
              {session.sectionId === "pinned" && (
                <Pin size={12} className="shrink-0 text-muted-foreground" />
              )}
              {session.parentSessionId !== undefined &&
                session.forkReason === undefined && (
                  <GitFork
                    size={13}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
            </button>
          </SidebarMenu>
        </div>
      ))}
      {list?.loading && sessions.length === 0 && (
        <p role="status" className="sidebar-list-note">
          Loading sessions…
        </p>
      )}
      {list?.error ? (
        <div className="sidebar-list-note">
          <p>{list.error}</p>
          <button
            type="button"
            onClick={() => void loadSessions(projectId, filter)}
          >
            Retry
          </button>
        </div>
      ) : (
        !list?.loading &&
        sessions.length === 0 && (
          <p className="sidebar-list-note">No sessions yet</p>
        )
      )}
      {(hasHiddenRows || list?.nextCursor) && (
        <button
          type="button"
          disabled={list?.loading}
          className="sidebar-row sidebar-list-more text-muted-foreground"
          onClick={() => {
            setVisibleCount((count) => Math.max(count, shownCount) + 5)
            if (!hasHiddenRows)
              void loadSessions(projectId, { ...filter, append: true })
          }}
        >
          Show more
        </button>
      )}
      {renaming && (
        <SidebarNameDialog
          title="Rename conversation"
          initialName={renaming.title ?? ""}
          onClose={() => setRenaming(undefined)}
          onSave={(title) =>
            changeSidebar({ type: "session", sessionId: renaming.id, title })
          }
        />
      )}
      {pendingDeleteId && (
        <SidebarDialog
          title="Delete conversation?"
          onClose={() => setPendingDeleteId(undefined)}
        >
          <p className="text-sm text-muted-foreground">
            This cannot be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setPendingDeleteId(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={inFlight.has(`delete:${pendingDeleteId}`)}
              onClick={() => {
                void deleteSession(pendingDeleteId).then(() =>
                  setPendingDeleteId(undefined),
                )
              }}
            >
              Confirm
            </Button>
          </div>
        </SidebarDialog>
      )}
    </>
  )
}
