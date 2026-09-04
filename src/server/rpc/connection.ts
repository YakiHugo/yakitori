// Per-connection handshake state for the C8-D1 host protocol, mirroring
// Codex's ConnectionSessionState: initialize is set-once, and the capabilities
// recorded there gate experimental methods and notification delivery for the
// life of the connection.

export type ConnectionCapabilities = Readonly<{
  experimentalApi: boolean
  optOutNotificationMethods: ReadonlySet<string>
}>

export class RpcConnectionState {
  private current: ConnectionCapabilities | undefined

  get initialized(): boolean {
    return this.current !== undefined
  }

  get capabilities(): ConnectionCapabilities | undefined {
    return this.current
  }

  markInitialized(capabilities: ConnectionCapabilities): void {
    if (this.current !== undefined) {
      throw new Error("Connection is already initialized.")
    }
    this.current = capabilities
  }
}
