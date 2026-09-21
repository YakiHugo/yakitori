import { randomUUID } from "node:crypto"
import { createYakitoriError, YakitoriErrorCode } from "../kernel/errors.ts"

export type SessionPresentation = Readonly<{
  title?: string
  archived?: boolean
  sectionId?: string
  sectionPosition?: number
  goal?: string
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
      goal?: string | null
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

export function emptySessionSidebar(): SessionSidebar {
  return { sections: [], entries: {} }
}

function invalid(message: string): never {
  throw createYakitoriError({
    code: YakitoriErrorCode.InvalidArgument,
    message,
  })
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    invalid(`${field} must not be empty.`)
  return value.trim()
}
export function parseSidebarChange(value: unknown): SidebarChange {
  if (typeof value !== "object" || value === null)
    invalid("Sidebar change must be an object.")
  const v = value as Record<string, unknown>
  switch (v.type) {
    case "session": {
      const sessionId = nonempty(v.sessionId, "sessionId")
      if (v.archived !== undefined && typeof v.archived !== "boolean")
        invalid("archived must be a boolean.")
      if (v.goal !== undefined && v.goal !== null) nonempty(v.goal, "goal")
      if (
        v.title === undefined &&
        v.archived === undefined &&
        v.sectionId === undefined &&
        v.goal === undefined
      )
        invalid("No session changes supplied.")
      return {
        type: v.type,
        sessionId,
        ...(v.title === undefined ? {} : { title: nonempty(v.title, "title") }),
        ...(v.archived === undefined
          ? {}
          : { archived: v.archived as boolean }),
        ...(v.sectionId === undefined
          ? {}
          : {
              sectionId:
                v.sectionId === null
                  ? null
                  : nonempty(v.sectionId, "sectionId"),
            }),
        ...(v.goal === undefined
          ? {}
          : { goal: v.goal === null ? null : nonempty(v.goal, "goal") }),
      }
    }
    case "move-session": {
      const sectionId =
        v.sectionId === null ? null : nonempty(v.sectionId, "sectionId")
      if (sectionId === null && v.beforeSessionId !== undefined)
        invalid("beforeSessionId requires a section.")
      return {
        type: v.type,
        sessionId: nonempty(v.sessionId, "sessionId"),
        sectionId,
        ...(v.beforeSessionId === undefined
          ? {}
          : {
              beforeSessionId: nonempty(v.beforeSessionId, "beforeSessionId"),
            }),
      }
    }
    case "create-section":
      return { type: v.type, name: nonempty(v.name, "name") }
    case "rename-section":
      return {
        type: v.type,
        sectionId: nonempty(v.sectionId, "sectionId"),
        name: nonempty(v.name, "name"),
      }
    case "delete-section":
      return { type: v.type, sectionId: nonempty(v.sectionId, "sectionId") }
    case "reorder-sections":
      if (
        !Array.isArray(v.sectionIds) ||
        !v.sectionIds.every((id) => typeof id === "string")
      )
        invalid("sectionIds must be a list of IDs.")
      return { type: v.type, sectionIds: v.sectionIds }
    default:
      return invalid("Unknown sidebar change.")
  }
}

// Codex sections are independent entities; pinning is membership in a built-in
// section. Yakitori binds presentation to the navigation root because edit/undo
// replaces its execution thread. It must not copy presentation onto every fork.
export function changeSessionSidebar(
  current: SessionSidebar,
  change: SidebarChange,
  sessions: readonly Readonly<{
    id: string
    navigationId: string
    updatedAt: string
  }>[],
): SessionSidebar {
  const state = structuredClone(current)
  const entries = { ...state.entries }
  switch (change.type) {
    case "session": {
      const session = sessions.find((entry) => entry.id === change.sessionId)
      if (!session)
        invalid("This conversation changed. Reopen it before updating it.")
      if (
        change.sectionId != null &&
        change.sectionId !== "pinned" &&
        !state.sections.some((section) => section.id === change.sectionId)
      )
        invalid("Section no longer exists.")
      const entry = { ...entries[session.navigationId] }
      if (change.title !== undefined) entry.title = change.title
      if (change.archived !== undefined) entry.archived = change.archived
      if (change.goal !== undefined) {
        if (change.goal === null) delete entry.goal
        else entry.goal = change.goal
      }
      entries[session.navigationId] = entry
      const next = { ...state, entries }
      return change.sectionId !== undefined &&
        change.sectionId !== (entry.sectionId ?? null)
        ? changeSessionSidebar(
            next,
            {
              type: "move-session",
              sessionId: session.id,
              sectionId: change.sectionId,
            },
            sessions,
          )
        : next
    }
    case "move-session": {
      const source = sessions.find((entry) => entry.id === change.sessionId)
      if (!source)
        invalid("This conversation changed. Reopen it before moving it.")
      const entry = { ...entries[source.navigationId] }
      if (change.sectionId === null) {
        if (change.beforeSessionId !== undefined)
          invalid("beforeSessionId requires a section.")
        delete entry.sectionId
        delete entry.sectionPosition
      } else {
        if (
          change.sectionId !== "pinned" &&
          !state.sections.some((section) => section.id === change.sectionId)
        )
          invalid("Section no longer exists.")
        const before =
          change.beforeSessionId === undefined
            ? undefined
            : sessions.find((session) => session.id === change.beforeSessionId)
        if (
          change.beforeSessionId !== undefined &&
          (!before ||
            before.id === source.id ||
            entries[before.navigationId]?.sectionId !== change.sectionId)
        )
          invalid("The destination conversation changed. Try the move again.")
        const members = sessions
          .filter(
            (session) =>
              session.id !== source.id &&
              entries[session.navigationId]?.sectionId === change.sectionId,
          )
          .map((session) => ({ ...session, ...entries[session.navigationId] }))
          .sort(compareSectionSessions)
        // Match Codex's sparse positions: use a gap/midpoint; renumber only
        // when a gap is exhausted or previously unranked entries are moved.
        const gap = 1_000_000
        const index =
          before === undefined
            ? members.length
            : members.findIndex((member) => member.id === before.id)
        const rank = () => {
          const lower =
            index === 0 ? 0 : (members[index - 1]?.sectionPosition ?? 0)
          const upper = members[index]?.sectionPosition
          return upper === undefined
            ? lower + gap
            : lower + Math.floor((upper - lower) / 2)
        }
        let position = rank()
        if (
          members.some((member) => member.sectionPosition === undefined) ||
          !Number.isSafeInteger(position) ||
          position <= (members[index - 1]?.sectionPosition ?? 0)
        ) {
          members.forEach((member, i) => {
            member.sectionPosition = (i + 1) * gap
            entries[member.navigationId] = {
              ...entries[member.navigationId],
              sectionPosition: member.sectionPosition,
            }
          })
          position = rank()
        }
        entry.sectionId = change.sectionId
        entry.sectionPosition = position
      }
      entries[source.navigationId] = entry
      return { ...state, entries }
    }
    case "create-section":
      return {
        ...state,
        sections: [
          ...state.sections,
          { id: `section_${randomUUID()}`, name: change.name },
        ],
      }
    case "rename-section":
    case "delete-section": {
      if (!state.sections.some((section) => section.id === change.sectionId))
        invalid("Custom section does not exist.")
      if (change.type === "rename-section")
        return {
          ...state,
          sections: state.sections.map((section) =>
            section.id === change.sectionId
              ? { ...section, name: change.name }
              : section,
          ),
        }
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.sectionId === change.sectionId) {
          const { sectionId: _, sectionPosition: __, ...rest } = entry
          entries[id] = rest
        }
      }
      return {
        entries,
        sections: state.sections.filter(
          (section) => section.id !== change.sectionId,
        ),
      }
    }
    case "reorder-sections": {
      if (
        new Set(change.sectionIds).size !== state.sections.length ||
        change.sectionIds.length !== state.sections.length ||
        state.sections.some(
          (section) => !change.sectionIds.includes(section.id),
        )
      )
        invalid("Include every custom section exactly once.")
      const byId = new Map(
        state.sections.map((section) => [section.id, section]),
      )
      return {
        ...state,
        sections: change.sectionIds.map((id) => byId.get(id) as SidebarSection),
      }
    }
  }
}

export function presentSession<T extends Readonly<{ navigationId?: string }>>(
  session: T,
  sidebar: SessionSidebar,
): T & SessionPresentation {
  return {
    ...session,
    ...(session.navigationId === undefined
      ? {}
      : sidebar.entries[session.navigationId]),
  }
}
export function sessionInView(
  session: SessionPresentation,
  filter: Readonly<{ archived?: boolean; sectionId?: string | null }>,
): boolean {
  return (
    (session.archived === true) === (filter.archived === true) &&
    (filter.sectionId === undefined ||
      (session.sectionId ?? null) === filter.sectionId)
  )
}

type OrderedSession = Readonly<{
  id: string
  navigationId?: string
  updatedAt: string
  sectionPosition?: number
}>
export function compareSectionSessions(
  left: OrderedSession,
  right: OrderedSession,
): number {
  const position =
    (left.sectionPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.sectionPosition ?? Number.MAX_SAFE_INTEGER)
  if (position) return position
  if (left.sectionPosition !== undefined && right.sectionPosition !== undefined)
    return (left.navigationId ?? left.id).localeCompare(
      right.navigationId ?? right.id,
    )
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    (right.navigationId ?? right.id).localeCompare(left.navigationId ?? left.id)
  )
}
export function sectionSessionCursor(session: OrderedSession): string {
  return JSON.stringify({
    id: session.navigationId ?? session.id,
    updatedAt: session.updatedAt,
    ...(session.sectionPosition === undefined
      ? {}
      : { sectionPosition: session.sectionPosition }),
  })
}
export function startAfterSectionCursor(
  sessions: readonly OrderedSession[],
  cursor: string | undefined,
): number {
  if (cursor === undefined) return 0
  const value: unknown = JSON.parse(cursor)
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    ("sectionPosition" in value &&
      (typeof value.sectionPosition !== "number" ||
        !Number.isSafeInteger(value.sectionPosition)))
  )
    invalid("Invalid section cursor.")
  const anchor = value as OrderedSession
  const index = sessions.findIndex(
    (session) => compareSectionSessions(session, anchor) > 0,
  )
  return index < 0 ? sessions.length : index
}
