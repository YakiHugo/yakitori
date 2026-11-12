import { initializeEngineSessions } from "./store/engine-store.ts"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { useAppStore } from "./store/app-store.ts"
import "./styles/globals.css"

const root = document.querySelector<HTMLDivElement>("#app")
if (!root) throw new Error("Missing app root.")

if (window.yakitoriDesktop?.platform === "darwin")
  document.documentElement.dataset.desktop = "macos"

const preview = new URLSearchParams(window.location.search).get("mock")
if (import.meta.env.DEV && preview === "sidebar") {
  const { seedMockSidebar } = await import("./mock-sidebar.ts")
  seedMockSidebar()
} else if (preview === "transcript") {
  const { seedMockTranscript } = await import("./mock-transcript.ts")
  seedMockTranscript()
} else {
  void useAppStore
    .getState()
    .boot()
    .then(() => initializeEngineSessions())
}

createRoot(root).render(<App />)
