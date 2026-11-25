import { createRoot } from "react-dom/client"
import { App } from "../../../src/gui/app.tsx"
import { useAppStore } from "../../../src/gui/store/app-store.ts"
import "../../../src/gui/styles/globals.css"

useAppStore.setState({
  apiBase: window.location.origin,
  defaultProvider: "shared-model-group",
  defaultModel: "sample",
  providers: [
    {
      name: "shared-model-group",
      models: [
        { id: "sample", displayName: "Sample", instructionProfileId: "test" },
      ],
    },
  ],
  accounts: [
    { name: "work", displayName: "Work account", models: [] },
    { name: "personal", displayName: "Personal account", models: [] },
    { name: "sandbox", displayName: "Sandbox account", models: [] },
  ],
})

const root = document.getElementById("app")
if (!root) throw new Error("Missing renderer fixture root")
createRoot(root).render(
  <>
    <App />
    <button
      type="button"
      className="fixed bottom-4 right-4 z-10"
      onClick={() =>
        useAppStore.setState({ selection: { sessionId: "second-session" } })
      }
    >
      Open second session
    </button>
  </>,
)
