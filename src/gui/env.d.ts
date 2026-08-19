/// <reference types="vite/client" />

type YakitoriDesktopBridge = {
  openFile(input: {
    readonly path: string
    readonly line?: number
  }): Promise<void>
  openUrl(input: { readonly url: string }): Promise<void>
}

interface Window {
  readonly yakitoriDesktop?: YakitoriDesktopBridge
}
