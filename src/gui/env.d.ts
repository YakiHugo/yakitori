/// <reference types="vite/client" />

type YakitoriDesktopBridge = {
  platform: string
  notifications: import("../desktop/completion-notification-types.ts").CompletionNotificationBridge
  writeClipboardText(text: string): Promise<void>
  browser: import("../desktop/workspace-browser-types.ts").WorkspaceBrowserBridge
  pickProjectFolder(): Promise<string | null>
  pickAttachments(): Promise<Readonly<{ selectionId: string }> | undefined>
  importPickedAttachments(
    input: Readonly<{
      sessionId?: string
      selectionId: string
    }>,
  ): Promise<readonly import("../kernel/events.ts").UserAttachment[]>
  discardPickedAttachments(
    input: Readonly<{
      selectionId: string
    }>,
  ): Promise<void>
  importAttachmentFiles(
    input: Readonly<{
      sessionId?: string
      files: readonly File[]
    }>,
  ): Promise<readonly import("../kernel/events.ts").UserAttachment[]>
  discardDraftAttachments(
    input: readonly import("../kernel/events.ts").UserAttachment[],
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
