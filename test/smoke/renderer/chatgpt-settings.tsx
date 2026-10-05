import { createRoot } from "react-dom/client"
import { ModelSelector } from "../../../src/gui/components/model-selector.tsx"
import { ProviderSettings } from "../../../src/gui/components/provider-settings.tsx"
import { useAppStore } from "../../../src/gui/store/app-store.ts"
import "../../../src/gui/styles/globals.css"

useAppStore.setState({
  apiBase: window.location.origin,
  settingsSection: "providers",
  providers: [
    {
      name: "chatgpt-personal",
      displayName: "ChatGPT · Personal",
      models: [
        {
          id: "qa-model",
          displayName: "QA model",
          instructionProfileId: "test",
        },
      ],
    },
  ],
  defaultProvider: "chatgpt-personal",
  defaultModel: "qa-model",
})
function RendererFixture() {
  const settings = useAppStore((state) => state.settingsSection)
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {settings ? (
        <ProviderSettings />
      ) : (
        <main className="p-8">
          <h1>Conversation</h1>
          <button
            type="button"
            onClick={() => useAppStore.getState().openSettings("providers")}
          >
            Open Providers settings
          </button>
        </main>
      )}
      <footer className="border-t p-4">
        <ModelSelector />
      </footer>
    </div>
  )
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing renderer fixture root")
createRoot(root).render(<RendererFixture />)
