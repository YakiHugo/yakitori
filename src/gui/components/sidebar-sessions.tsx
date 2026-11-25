import { useTranslation } from "../i18n/use-translation.ts"
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  FolderInput,
  GitFork,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import type { ApiSessionSummary } from "../../protocol/application.ts"
import {
  type SidebarListFilter,
  sessionListKey,
  useAppStore,
} from "../store/app-store.ts"
import { SessionStatus } from "./session-status.tsx"
import { SidebarNameDialog } from "./sidebar-name-dialog.tsx"
import { SidebarDialog, SidebarMenu } from "./sidebar-surfaces.tsx"
import { Button } from "./ui/button.tsx"

export function SessionItems({
  projectId,
  sectionId,
  archived,
  onSelect,
}: Readonly<{ projectId?: string | undefined; onSelect?(): void }> &
  SidebarListFilter) {
  const { t } = useTranslation()
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
          key={session.id}
          className="sidebar-session group"
          data-sidebar-layout={`session:${sessionListKey(projectId, filter)}:${session.id}`}
          data-sidebar-drop={archived ? undefined : "session"}
          data-drop-id={session.id}
          data-drop-section={sectionId}
          data-drop-label={session.title ?? t("Untitled session")}
          data-selected={session.id === selectedId}
        >
          <SidebarMenu
            label={t(
              "Session actions for {0}",
              session.title ?? t("Untitled session"),
            )}
            items={[
              ...(sectionId && index > 0
                ? [
                    {
                      label: t("Move up"),
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
                      label: t("Move down"),
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
                label: session.sectionId === "pinned" ? t("Unpin") : t("Pin"),
                icon: <Pin size={15} />,
                action: () =>
                  void changeSidebar({
                    type: "session",
                    sessionId: session.id,
                    sectionId: session.sectionId === "pinned" ? null : "pinned",
                  }),
              },
              {
                label: t("Rename"),
                icon: <Pencil size={15} />,
                action: () => setRenaming(session),
              },
              {
                label: t("Move to section"),
                icon: <FolderInput size={15} />,
                items: [
                  { id: "", name: t("Projects / All sessions") },
                  { id: "pinned", name: t("Pinned") },
                  ...sections,
                ].map((section) => ({
                  id: section.id,
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
                  ? t("Restore conversation")
                  : t("Archive conversation"),
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
                label: t("Delete conversation"),
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
              aria-label={session.title ?? t("Untitled session")}
              title={session.title ?? t("Untitled session")}
              onClick={() => {
                onSelect?.()
                void selectSession(session.id, session)
              }}
              className="sidebar-row min-w-0 flex-1"
            >
              <SessionStatus session={session} />
              <span className="min-w-0 flex-1 truncate text-left">
                {session.title ?? t("Untitled session")}
              </span>
              {session.sectionId === "pinned" && (
                <Pin size={12} className="shrink-0 text-muted-foreground" />
              )}
              {session.parentSessionId !== undefined && (
                <GitFork size={13} className="shrink-0 text-muted-foreground" />
              )}
            </button>
          </SidebarMenu>
        </div>
      ))}
      {list?.loading && sessions.length === 0 && (
        <p role="status" className="sidebar-list-note">
          {t("Loading sessions…")}
        </p>
      )}
      {list?.error ? (
        <div className="sidebar-list-note">
          <p>{list.error}</p>
          <button
            type="button"
            onClick={() => void loadSessions(projectId, filter)}
          >
            {t("Retry")}
          </button>
        </div>
      ) : (
        !list?.loading &&
        sessions.length === 0 && (
          <p className="sidebar-list-note">{t("No sessions yet")}</p>
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
          {t("Show more")}
        </button>
      )}
      {renaming && (
        <SidebarNameDialog
          title={t("Rename conversation")}
          initialName={renaming.title ?? ""}
          onClose={() => setRenaming(undefined)}
          onSave={(title) =>
            changeSidebar({ type: "session", sessionId: renaming.id, title })
          }
        />
      )}
      {pendingDeleteId && (
        <SidebarDialog
          title={t("Delete conversation?")}
          onClose={() => setPendingDeleteId(undefined)}
        >
          <p className="text-sm text-muted-foreground">
            {t(
              "This cannot be undone. Side chats and unsaved file drafts belonging to this conversation will also close.",
            )}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setPendingDeleteId(undefined)}
            >
              {t("Cancel")}
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
              {t("Confirm")}
            </Button>
          </div>
        </SidebarDialog>
      )}
    </>
  )
}
