export type WorkspaceBrowserState = Readonly<{
  tabId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}>

export type WorkspaceBrowserSelection = Readonly<{
  tabId: string
  text: string
  url: string
  title: string
  action: "add" | "chat"
}>

export type WorkspaceBrowserViewport = Readonly<{
  tabId: string
  visible: boolean
  occluded?: boolean
  x: number
  y: number
  width: number
  height: number
}>

export type WorkspaceBrowserShortcut =
  | "new-browser"
  | "open-files"
  | "new-side-chat"
  | "toggle-workspace"

export type WorkspaceBrowserBridge = Readonly<{
  create(input: { tabId: string; url?: string }): Promise<WorkspaceBrowserState>
  navigate(input: { tabId: string; url: string }): Promise<void>
  action(input: {
    tabId: string
    action: "back" | "forward" | "reload" | "stop"
  }): Promise<void>
  viewport(input: WorkspaceBrowserViewport): Promise<string | undefined>
  selection(input: { tabId: string; action: "add" | "chat" }): Promise<void>
  close(input: { tabId: string }): Promise<void>
  onState(listener: (state: WorkspaceBrowserState) => void): () => void
  onSelection(
    listener: (selection: WorkspaceBrowserSelection) => void,
  ): () => void
  onShortcut(listener: (action: WorkspaceBrowserShortcut) => void): () => void
}>
