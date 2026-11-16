export type DesktopBuildInfo = Readonly<{
  repository: string
  version: string
  commit: string
  dirty: boolean
  channel: "local" | "main"
  buildNumber: number
  buildAttempt: number
  builtAt: string
  platform: "darwin"
  arch: "arm64"
}>

export type DesktopUpdateRelease = Readonly<{
  source?: "local"
  version: string
  commit: string
  buildNumber: number
  buildAttempt: number
  publishedAt: string
  releaseUrl: string
}>

export type DesktopUpdateState =
  | Readonly<{ phase: "unavailable"; reason: string }>
  | Readonly<{ phase: "idle" | "checking"; current: DesktopBuildInfo }>
  | Readonly<{
      phase: "available" | "preparing" | "ready" | "installing"
      current: DesktopBuildInfo
      release: DesktopUpdateRelease
    }>
  | Readonly<{
      phase: "downloading"
      current: DesktopBuildInfo
      release: DesktopUpdateRelease
      downloadedBytes: number
      reusedBytes?: number
      totalBytes: number
    }>
  | Readonly<{
      phase: "error"
      current: DesktopBuildInfo
      release?: DesktopUpdateRelease
      message: string
      retry: "check" | "download" | "install"
    }>

export type DesktopUpdateBridge = Readonly<{
  getState(): Promise<DesktopUpdateState>
  check(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  onState(listener: (state: DesktopUpdateState) => void): () => void
}>
