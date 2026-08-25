/// <reference types="vite/client" />

type YakitoriDesktopBridge = {
  pickImages(input: {
    readonly sessionId: string
  }): Promise<readonly import("../kernel/events.ts").ImageAttachment[]>
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
  }): Promise<void>
  openUrl(input: { readonly url: string }): Promise<void>
}

interface Window {
  readonly yakitoriDesktop?: YakitoriDesktopBridge
}
