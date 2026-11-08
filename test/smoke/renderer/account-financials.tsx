import { createRoot } from "react-dom/client"
import { SessionCommandPanel } from "../../../src/gui/components/session-command-panel.tsx"
import { SubscriptionsSection } from "../../../src/gui/components/subscription-panel.tsx"
import { useAppStore } from "../../../src/gui/store/app-store.ts"
import "../../../src/gui/styles/globals.css"

useAppStore.setState({
  apiBase: window.location.origin,
  accounts: ["deepseek-work", "router-work"].map((name) => ({
    name,
    models: [],
  })),
  selection: { sessionId: "financial-reporting" },
})
void useAppStore.getState().loadSubscriptions()

function RendererFixture() {
  return (
    <main className="h-screen overflow-y-auto p-4">
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-lg font-semibold">
          Account balances and key budgets
        </h1>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-xs"
            onClick={() => void useAppStore.getState().loadSubscriptions()}
          >
            Refresh accounts
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-xs"
            onClick={() =>
              useAppStore.setState((state) => ({
                execution: {
                  ...state.execution,
                  lastModel: { provider: "router-work", model: "qa-model" },
                },
                commandPanel: {
                  kind: "status",
                  sessionId: "financial-reporting",
                },
              }))
            }
          >
            Show OpenRouter status
          </button>
        </div>
        <SubscriptionsSection />
        <SessionCommandPanel />
      </div>
    </main>
  )
}

const root = document.getElementById("app")
if (!root) throw new Error("Missing renderer fixture root")
createRoot(root).render(<RendererFixture />)
