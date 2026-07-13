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
import "./styles.css"

type StreamStatus = "connected" | "connecting" | "disconnected" | "idle"

type AppState = {
  apiBase: string
  busy: boolean
  events: EventEnvelope[]
  message?: string
  nextCursor?: string
  promptDraft?: string
  selectedSession?: ApiSessionDetail
  selectedSessionId?: string
  sessions: ApiSessionSummary[]
  stream?: EventSource
  streamStatus: StreamStatus
}

const root = requireRoot()

const state: AppState = {
  apiBase: initialApiBase(),
  busy: false,
  events: [],
  sessions: [],
  streamStatus: "idle",
}

void boot()

async function boot(): Promise<void> {
  const loaded = await loadSessions()
  if (!loaded) return
  const session = state.sessions.at(0)
  if (session) {
    await selectSession(session.id)
    return
  }
  delete state.selectedSession
  delete state.selectedSessionId
  state.events = []
  render()
}

async function loadSessions(
  input: { readonly append?: boolean } = {},
): Promise<boolean> {
  return await runTask(async () => {
    const response = await requestJson<ApiListSessionsResponse>(
      `/sessions?limit=30${state.nextCursor && input.append ? `&cursor=${encodeURIComponent(state.nextCursor)}` : ""}`,
    )
    state.sessions = input.append
      ? [...state.sessions, ...response.sessions]
      : [...response.sessions]
    if (response.nextCursor === undefined) {
      delete state.nextCursor
      return
    }
    state.nextCursor = response.nextCursor
  })
}

async function createSession(): Promise<void> {
  await runTask(async () => {
    const response = await requestJson<ApiCreateSessionResponse>("/sessions", {
      method: "POST",
      body: {
        title: `Session ${new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
      },
    })

    state.selectedSessionId = response.session.id
    state.selectedSession = response.session
    state.events = [response.event]
    delete state.promptDraft
    await loadSessions()
    connectEvents(response.session.id, response.event.seq)
  })
}

async function selectSession(sessionId: string): Promise<void> {
  await runTask(async () => {
    closeStream()
    state.selectedSessionId = sessionId
    state.events = []
    delete state.promptDraft
    const response = await requestJson<ApiReadSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    )
    state.selectedSession = response.session
    connectEvents(sessionId, 0)
  })
}

async function admitInput(text: string): Promise<boolean> {
  const sessionId = state.selectedSessionId
  if (!sessionId) return false

  return await runTask(async () => {
    const response = await requestJson<ApiAdmitInputResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/inputs`,
      {
        method: "POST",
        body: {
          content: {
            kind: "text",
            text,
          },
        },
      },
    )
    mergeEvent(response.event)
    await refreshSelectedSession()
    await loadSessions()
  })
}

async function refreshSelectedSession(): Promise<void> {
  const sessionId = state.selectedSessionId
  if (!sessionId) return
  const response = await requestJson<ApiReadSessionResponse>(
    `/sessions/${encodeURIComponent(sessionId)}`,
  )
  state.selectedSession = response.session
}

function connectEvents(sessionId: string, after: number): void {
  closeStream()

  try {
    state.streamStatus = "connecting"
    const source = new EventSource(
      apiUrl(
        `/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
      ),
    )
    state.stream = source

    source.addEventListener("open", () => {
      if (state.stream !== source) return
      state.streamStatus = "connected"
      render()
    })
    source.addEventListener("session.event", (message) => {
      if (state.stream !== source) return
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as EventEnvelope
      if (event.sessionId !== state.selectedSessionId) return
      mergeEvent(event)
      void refreshSelectedSession().then(() => {
        render()
      })
    })
    source.addEventListener("error", () => {
      if (state.stream !== source) return
      state.streamStatus = "disconnected"
      render()
    })
  } catch (error) {
    closeStream()
    state.message =
      error instanceof Error ? error.message : "Could not open event stream."
  }
}

function closeStream(): void {
  state.stream?.close()
  delete state.stream
  state.streamStatus = "idle"
}

async function runTask(task: () => Promise<void>): Promise<boolean> {
  state.busy = true
  delete state.message
  render()

  try {
    await task()
    return true
  } catch (error) {
    state.message = error instanceof Error ? error.message : "Request failed."
    return false
  } finally {
    state.busy = false
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
      const selected = session.id === state.selectedSessionId ? " selected" : ""
      const current =
        session.id === state.selectedSessionId ? ' aria-current="true"' : ""
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
      void (async () => {
        const admitted = await admitInput(text)
        if (!admitted) return
        delete state.promptDraft
        render()
      })()
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
  state.events = []
  state.sessions = []
  delete state.nextCursor
  delete state.promptDraft
  delete state.selectedSession
  delete state.selectedSessionId
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
