import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ModelSelector } from "../../../src/gui/components/model-selector.tsx"
import { useAppStore } from "../../../src/gui/store/app-store.ts"
import type { ModelSelection } from "../../../src/protocol/events.ts"
import "../../../src/gui/styles/globals.css"

useAppStore.setState({
  providers: [
    {
      name: "tencent",
      models: [
        {
          id: "vision",
          displayName: "HY Vision",
          instructionProfileId: "default",
          toolPolicy: "chat_only",
        },
        {
          id: "tool-model",
          displayName: "Tool model",
          instructionProfileId: "default",
        },
      ],
    },
  ],
})
function Fixture() {
  const [selection, setSelection] = useState<ModelSelection | undefined>({
    provider: "tencent",
    model: "vision",
  })
  return (
    <main className="p-16">
      <ModelSelector
        selection={selection}
        onChange={setSelection}
        routePreview={{
          value: {
            available: true,
            ...(selection === undefined ? {} : { target: selection }),
            efforts: [],
            speeds: [],
            inputModalities: ["text", "image"],
            imageDetailModes: ["high"],
            rejections: [],
            ...(selection?.model === "vision"
              ? { toolPolicy: "chat_only" as const }
              : {}),
          },
        }}
      />
    </main>
  )
}
const root = document.getElementById("app")
if (!root) throw new Error("Missing root")
createRoot(root).render(<Fixture />)
