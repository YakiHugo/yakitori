import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { useAppStore } from "./store/app-store.ts"
import "./styles/globals.css"

const root = document.querySelector<HTMLDivElement>("#app")
if (!root) throw new Error("Missing app root.")

if (window.yakitoriDesktop?.platform === "darwin")
  document.documentElement.dataset.desktop = "macos"

void useAppStore.getState().boot()

createRoot(root).render(<App />)
