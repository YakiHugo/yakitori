import type { EventEnvelope } from "../kernel/index.ts"
import type {
  ApiAdmitInputResponse,
  ApiCreateSessionResponse,
  ApiErrorResponse,
  ApiListSessionsResponse,
  ApiReadSessionResponse,
  ApiSessionDetail,
  ApiSessionSummary,
} from "../server/protocol.ts"
import { acknowledgeAdmission, reserveAdmission } from "./admission-outbox.ts"
import {
  beginSessionSelection,
  clearSessionSelection,
  createSessionSelectionState,
  currentSessionSelection,
  isCurrentSessionSelection,
  type SessionSelection,
} from "./session-selection.ts"
import "./styles.css"

type StreamStatus = "connected" | "connecting" | "disconnected" | "idle"

type AppState = {
  apiBase: string
  apiRevision: number
  busy: boolean
  events: EventEnvelope[]
  message?: string
  nextCursor?: string
  promptDraft?: string
  selection: ReturnType<typeof createSessionSelectionState>
  sessionDetailRevision: number
  sessionListRevision: number
  sessionSelectionIntentRevision: number
  selectedSession?: ApiSessionDetail
  sessions: ApiSessionSummary[]
  stream?: EventSource
  streamStatus: StreamStatus
}

const root = requireRoot()

const state: AppState = {
  apiBase: initialApiBase(),
  apiRevision: 0,
  busy: false,
  events: [],
  selection: createSessionSelectionState(),
  sessionDetailRevision: 0,
  sessionListRevision: 0,
  sessionSelectionIntentRevision: 0,
  sessions: [],
  streamStatus: "idle",
}
let activeTaskCount = 0

void boot()

async function boot(): Promise<void> {
  const apiRevision = state.apiRevision
  const intentRevision = state.sessionSelectionIntentRevision
  const loaded = await loadSessions()
  if (
    !loaded ||
    state.apiRevision !== apiRevision ||
    state.sessionSelectionIntentRevision !== intentRevision
  ) {
    return
  }
  const session = state.sessions.at(0)
  if (session) {
    await selectSession(session.id)
    return
  }
  closeStream()
  clearSessionSelection(state.selection)
  state.sessionDetailRevision += 1
  delete state.selectedSession
  state.events = []
  render()
}

async function loadSessions(
  input: { readonly append?: boolean } = {},
): Promise<boolean> {
  const apiRevision = state.apiRevision
  const requestRevision = ++state.sessionListRevision
  const existingSessions = state.sessions
  const cursor = input.append ? state.nextCursor : undefined
  let applied = false
  const completed = await runTask(
    async () => {
      const response = await requestJson<ApiListSessionsResponse>(
        `/sessions?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
      if (
        state.apiRevision !== apiRevision ||
        state.sessionListRevision !== requestRevision
      ) {
        return
      }
      state.sessions = input.append
        ? [...existingSessions, ...response.sessions]
        : [...response.sessions]
      applied = true
      if (response.nextCursor === undefined) {
        delete state.nextCursor
        return
      }
      state.nextCursor = response.nextCursor
    },
    () =>
      state.apiRevision === apiRevision &&
      state.sessionListRevision === requestRevision,
  )
  return completed && applied
}

async function createSession(): Promise<void> {
  const apiRevision = state.apiRevision
  const intentRevision = ++state.sessionSelectionIntentRevision
  await runTask(
    async () => {
      const response = await requestJson<ApiCreateSessionResponse>(
        "/sessions",
        {
          method: "POST",
          body: {
            title: `Session ${new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          },
        },
      )

      if (state.apiRevision !== apiRevision) return
      await loadSessions()
      if (state.sessionSelectionIntentRevision !== intentRevision) return
      const selection = activateSession(response.session.id)
      state.selectedSession = response.session
      state.events = [response.event]
      delete state.promptDraft
      connectEvents(selection, response.event.seq)
    },
    () =>
      state.apiRevision === apiRevision &&
      state.sessionSelectionIntentRevision === intentRevision,
  )
}

async function selectSession(sessionId: string): Promise<void> {
  state.sessionSelectionIntentRevision += 1
  const selection = activateSession(sessionId)
  closeStream()
  state.events = []
  delete state.promptDraft
  delete state.selectedSession
  await runTask(
    async () => {
      const applied = await refreshSelectedSession(selection)
      if (!applied) return
      connectEvents(selection, 0)
    },
    () => isCurrentSessionSelection(state.selection, selection),
  )
}

async function admitInput(text: string): Promise<void> {
  const selection = currentSessionSelection(state.selection)
  if (!selection) return

  await runTask(
    async () => {
      const pendingAdmission = await reserveAdmission(localStorage, {
        apiBase: state.apiBase,
        sessionId: selection.sessionId,
        text,
      })
      if (!isCurrentSessionSelection(state.selection, selection)) return
      const response = await requestJson<ApiAdmitInputResponse>(
        `/sessions/${encodeURIComponent(selection.sessionId)}/inputs`,
        {
          method: "POST",
          body: {
            requestId: pendingAdmission.requestId,
            content: {
              kind: "text",
              text,
            },
          },
        },
      )
      if (
        response.requestId !== pendingAdmission.requestId ||
        response.event.sessionId !== selection.sessionId
      ) {
        throw new Error("Admission response did not match the request.")
      }
      await acknowledgeAdmission(localStorage, pendingAdmission)
      if (!isCurrentSessionSelection(state.selection, selection)) return
      if (state.promptDraft?.trim() === text) delete state.promptDraft
      mergeEvent(response.event)
      await refreshSelectedSession(selection)
      if (!isCurrentSessionSelection(state.selection, selection)) return
      await loadSessions()
    },
    () => isCurrentSessionSelection(state.selection, selection),
  )
}

async function refreshSelectedSession(
  selection: SessionSelection,
): Promise<boolean> {
  const requestRevision = ++state.sessionDetailRevision
  let response: ApiReadSessionResponse
  try {
    response = await requestJson<ApiReadSessionResponse>(
      `/sessions/${encodeURIComponent(selection.sessionId)}`,
    )
  } catch (error) {
    if (
      !isCurrentSessionSelection(state.selection, selection) ||
      state.sessionDetailRevision !== requestRevision
    ) {
      return false
    }
    throw error
  }
  if (
    !isCurrentSessionSelection(state.selection, selection) ||
    state.sessionDetailRevision !== requestRevision
  ) {
    return false
  }
  state.selectedSession = response.session
  return true
}

function connectEvents(selection: SessionSelection, after: number): void {
  if (!isCurrentSessionSelection(state.selection, selection)) return
  closeStream()

  try {
    state.streamStatus = "connecting"
    const source = new EventSource(
      apiUrl(
        `/sessions/${encodeURIComponent(selection.sessionId)}/events?after=${after}`,
      ),
    )
    state.stream = source

    source.addEventListener("open", () => {
      if (
        state.stream !== source ||
        !isCurrentSessionSelection(state.selection, selection)
      ) {
        return
      }
      state.streamStatus = "connected"
      render()
    })
    source.addEventListener("session.event", (message) => {
      if (
        state.stream !== source ||
        !isCurrentSessionSelection(state.selection, selection)
      ) {
        return
      }
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as EventEnvelope
      if (event.sessionId !== selection.sessionId) return
      mergeEvent(event)
      void refreshSelectedSession(selection).then(
        () => {
          if (!isCurrentSessionSelection(state.selection, selection)) return
          render()
        },
        (error: unknown) => {
          if (!isCurrentSessionSelection(state.selection, selection)) return
          state.message = errorMessage(error, "Could not refresh session.")
          render()
        },
      )
    })
    source.addEventListener("error", () => {
      if (
        state.stream !== source ||
        !isCurrentSessionSelection(state.selection, selection)
      ) {
        return
      }
      state.streamStatus = "disconnected"
      render()
    })
  } catch (error) {
    closeStream()
    if (!isCurrentSessionSelection(state.selection, selection)) return
    state.message = errorMessage(error, "Could not open event stream.")
  }
}

function closeStream(): void {
  state.stream?.close()
  delete state.stream
  state.streamStatus = "idle"
}

async function runTask(
  task: () => Promise<void>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  activeTaskCount += 1
  state.busy = true
  if (isCurrent()) delete state.message
  render()

  try {
    await task()
    return true
  } catch (error) {
    if (isCurrent()) state.message = errorMessage(error, "Request failed.")
    return false
  } finally {
    activeTaskCount -= 1
    state.busy = activeTaskCount > 0
    render()
  }
}

async function requestJson<T>(
  path: string,
  init: {
    readonly body?: unknown
    readonly method?: "GET" | "POST"
  } = {},
): Promise<T> {
  const request =
    init.body === undefined
      ? { method: init.method ?? "GET" }
      : {
          method: init.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(init.body),
        }
  const response = await fetch(apiUrl(path), request)
  const payload = (await response.json()) as T | ApiErrorResponse
  if (response.ok) return payload as T
  throw new Error(
    isApiErrorResponse(payload)
      ? payload.error.message
      : `HTTP ${response.status}`,
  )
}

function render(): void {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <h1>Yakitori</h1>
            <p>Harness explorer</p>
          </div>
        </div>
        <form class="api-form" id="apiForm">
          <label for="apiBase">API</label>
          <input id="apiBase" name="apiBase" value="${escapeHtml(state.apiBase)}" />
          <button type="submit">Connect</button>
        </form>
      </header>

      <div class="global-message ${state.message ? "" : "empty"}" role="alert" aria-live="polite">
        ${state.message ? escapeHtml(state.message) : ""}
      </div>

      <aside class="session-pane">
        <div class="pane-head">
          <h2>Sessions</h2>
          <button type="button" id="newSession">+ New</button>
        </div>
        <div class="session-list">
          ${renderSessions()}
        </div>
        ${
          state.nextCursor
            ? '<button class="load-more" type="button" id="loadMore">More</button>'
            : ""
        }
      </aside>

      <main class="workbench">
        ${renderSessionDetail()}
      </main>

      <section class="event-pane">
        <div class="pane-head">
          <h2>Events</h2>
          <span class="stream-pill ${state.streamStatus}">${state.streamStatus}</span>
        </div>
        <div class="event-list">
          ${renderEvents()}
        </div>
      </section>
    </div>
  `

  bindEvents()
}

function renderSessions(): string {
  if (state.sessions.length === 0) {
    return `<div class="empty-state">No sessions</div>`
  }

  return state.sessions
    .map((session) => {
      const selected =
        session.id === state.selection.sessionId ? " selected" : ""
      const current =
        session.id === state.selection.sessionId ? ' aria-current="true"' : ""
      return `
        <button class="session-row${selected}" type="button" data-session-id="${escapeHtml(session.id)}"${current}>
          <span class="session-title">${escapeHtml(session.title ?? "Untitled session")}</span>
          <span class="session-meta">seq ${session.seq} / ${formatTime(session.updatedAt)}</span>
        </button>
      `
    })
    .join("")
}

function renderSessionDetail(): string {
  const session = state.selectedSession
  if (!session) {
    return `
      <section class="focus-empty">
        <h2>No session selected</h2>
        <button type="button" id="emptyNewSession">+ New</button>
      </section>
    `
  }

  return `
    <section class="session-band">
      <div>
        <p class="eyebrow">Active session</p>
        <h2>${escapeHtml(session.title ?? "Untitled session")}</h2>
        <p class="session-id">${escapeHtml(session.id)}</p>
      </div>
      <div class="seq-block">
        <span>${session.seq}</span>
        <small>sequence</small>
      </div>
    </section>

    <section class="metrics-grid">
      ${metric("Inputs", session.counts.inputs)}
      ${metric("Pending", session.counts.pendingInputs)}
      ${metric("Turns", session.counts.turns)}
      ${metric("Items", session.counts.items)}
      ${metric("Tools", session.counts.tools)}
      ${metric("Permissions", session.counts.permissions)}
    </section>

    <form class="prompt-panel" id="promptForm">
      <label for="promptText">Input</label>
      <textarea id="promptText" name="promptText" rows="7" placeholder="Record durable input">${escapeHtml(state.promptDraft ?? "")}</textarea>
      <div class="prompt-actions">
        <span>${state.message ? escapeHtml(state.message) : ""}</span>
        <button type="submit" ${state.busy ? "disabled" : ""}>Admit</button>
      </div>
    </form>
  `
}

function renderEvents(): string {
  if (state.events.length === 0) {
    return `<div class="empty-state">No events</div>`
  }

  return [...state.events]
    .reverse()
    .map((event) => {
      return `
        <article class="event-row ${eventTone(event.type)}">
          <header>
            <span>${escapeHtml(event.type)}</span>
            <time>${formatTime(event.createdAt)}</time>
          </header>
          <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
        </article>
      `
    })
    .join("")
}

function bindEvents(): void {
  document
    .querySelector<HTMLFormElement>("#apiForm")
    ?.addEventListener("submit", (event) => {
      event.preventDefault()
      const form = event.currentTarget
      if (!(form instanceof HTMLFormElement)) return
      const data = new FormData(form)
      state.apiBase = String(data.get("apiBase") ?? "").trim()
      localStorage.setItem("yakitori.apiBase", state.apiBase)
      closeStream()
      clearSessionState()
      void boot()
    })

  document
    .querySelector<HTMLButtonElement>("#newSession")
    ?.addEventListener("click", () => {
      void createSession()
    })
  document
    .querySelector<HTMLButtonElement>("#emptyNewSession")
    ?.addEventListener("click", () => {
      void createSession()
    })
  document
    .querySelector<HTMLButtonElement>("#loadMore")
    ?.addEventListener("click", () => {
      void loadSessions({ append: true })
    })

  for (const row of document.querySelectorAll<HTMLButtonElement>(
    "[data-session-id]",
  )) {
    row.addEventListener("click", () => {
      const sessionId = row.dataset.sessionId
      if (sessionId) void selectSession(sessionId)
    })
  }

  document
    .querySelector<HTMLFormElement>("#promptForm")
    ?.addEventListener("submit", (event) => {
      event.preventDefault()
      const textarea =
        document.querySelector<HTMLTextAreaElement>("#promptText")
      const text = (state.promptDraft ?? textarea?.value ?? "").trim()
      if (!text) return
      void admitInput(text)
    })
  document
    .querySelector<HTMLTextAreaElement>("#promptText")
    ?.addEventListener("input", (event) => {
      const textarea = event.currentTarget
      if (!(textarea instanceof HTMLTextAreaElement)) return
      state.promptDraft = textarea.value
    })
}

function clearSessionState(): void {
  state.apiRevision += 1
  state.events = []
  state.sessionDetailRevision += 1
  state.sessionListRevision += 1
  state.sessionSelectionIntentRevision += 1
  state.sessions = []
  clearSessionSelection(state.selection)
  delete state.nextCursor
  delete state.promptDraft
  delete state.selectedSession
}

function activateSession(sessionId: string): SessionSelection {
  state.sessionDetailRevision += 1
  return beginSessionSelection(state.selection, sessionId)
}

function mergeEvent(event: EventEnvelope): void {
  if (state.events.some((candidate) => candidate.id === event.id)) return
  state.events = [...state.events, event].sort(
    (left, right) => left.seq - right.seq,
  )
}

function metric(label: string, value: number): string {
  return `
    <div class="metric">
      <span>${value}</span>
      <small>${escapeHtml(label)}</small>
    </div>
  `
}

function eventTone(type: string): string {
  if (type.includes("failed") || type.includes("cancelled")) return "danger"
  if (type.includes("created") || type.includes("admitted")) return "fresh"
  if (type.includes("completed") || type.includes("resolved")) return "settled"
  return "neutral"
}

function apiUrl(path: string): string {
  const base = state.apiBase.endsWith("/") ? state.apiBase : `${state.apiBase}/`
  return new URL(path.replace(/^\//, ""), base).toString()
}

function initialApiBase(): string {
  const queryApi = new URLSearchParams(window.location.search).get("api")
  if (queryApi) return queryApi
  return localStorage.getItem("yakitori.apiBase") ?? window.location.origin
}

function requireRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>("#app")
  if (element) return element
  throw new Error("Missing app root.")
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string"
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  return fallback
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
