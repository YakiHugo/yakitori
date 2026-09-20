/// <reference types="vite/client" />

type YakitoriDesktopBridge = {
  platform: string
  writeClipboardText(text: string): Promise<void>
  browser: import("../desktop/workspace-browser-types.ts").WorkspaceBrowserBridge
  pickProjectFolder(): Promise<string | null>
  pickImages(): Promise<{ readonly selectionId: string } | undefined>
  importPickedImages(input: {
    readonly sessionId: string
    readonly selectionId: string
  }): Promise<readonly import("../kernel/events.ts").ImageAttachment[]>
  discardPickedImages(input: { readonly selectionId: string }): Promise<void>
  importImageFiles(input: {
    readonly sessionId: string
    readonly files: readonly File[]
  }): Promise<readonly import("../kernel/events.ts").ImageAttachment[]>
  discardDraftImages(
    input: readonly import("../kernel/events.ts").ImageAttachment[],
  ): Promise<void>
  openFile(input: {
    readonly path: string
    readonly line?: number
    readonly workspaceRoot?: string
  }): Promise<void>
  openUrl(input: { readonly url: string }): Promise<void>
}

interface Window {
  readonly yakitoriDesktop?: YakitoriDesktopBridge
}
