import { ArrowLeft, ArrowRight, House, PanelLeft, Settings } from "lucide-react"
import { useEffect } from "react"
import { useNavigationHistory } from "../hooks/use-navigation-history.ts"
import { useAppStore } from "../store/app-store.ts"

export function WindowChrome({
  sidebarOpen,
  onToggleSidebar,
}: Readonly<{ sidebarOpen: boolean; onToggleSidebar(): void }>) {
  const settingsOpen = useAppStore(
    (state) => state.settingsSection !== undefined,
  )
  const openSettings = useAppStore((state) => state.openSettings)
  const closeSettings = useAppStore((state) => state.closeSettings)
  const history = useNavigationHistory()
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.shiftKey ||
        document.querySelector("dialog[open], [role=dialog]")
      )
        return
      const command = (event.metaKey || event.ctrlKey) && !event.altKey
      if (command && event.key === ",") {
        event.preventDefault()
        openSettings()
        return
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, [contenteditable=true]")
      )
        return
      const back =
        (command && event.key === "[") ||
        (event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          event.key === "ArrowLeft")
      const forward =
        (command && event.key === "]") ||
        (event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          event.key === "ArrowRight")
      if (back || forward) {
        event.preventDefault()
        if (back) history.back()
        else history.forward()
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [history, openSettings])
  return (
    <>
      <header className="window-titlebar">
        <button
          type="button"
          className="sidebar-icon"
          aria-label="Go back"
          title="Go back (⌘[)"
          disabled={!history.canGoBack}
          onClick={history.back}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="sidebar-icon"
          aria-label="Go forward"
          title="Go forward (⌘])"
          disabled={!history.canGoForward}
          onClick={history.forward}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="sidebar-icon"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          title={`${sidebarOpen ? "Hide" : "Show"} sidebar (⌘B)`}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
          disabled={settingsOpen}
        >
          <PanelLeft size={16} />
        </button>
      </header>
      <nav className="window-rail" aria-label="App navigation">
        <button
          type="button"
          className="window-rail-button"
          aria-label="Chats"
          title="Chats"
          aria-current={!settingsOpen ? "page" : undefined}
          onClick={closeSettings}
        >
          <House size={20} />
        </button>
        <button
          type="button"
          className="window-rail-button window-rail-settings"
          aria-label="Settings"
          title="Settings"
          aria-current={settingsOpen ? "page" : undefined}
          onClick={() => openSettings()}
        >
          <Settings size={19} />
        </button>
      </nav>
    </>
  )
}
