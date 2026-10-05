import type { Socket } from "node:net"

type Connect = (this: Socket, ...args: unknown[]) => Socket

export function createTestNetworkGuard(originalConnect: Socket["connect"]) {
  const blocked: string[] = []
  return {
    connect(this: Socket, ...args: unknown[]) {
      const first = args[0]
      const options: unknown = Array.isArray(first) ? first[0] : first
      const host =
        typeof options === "object" && options !== null && "host" in options
          ? options.host
          : typeof args[1] === "string"
            ? args[1]
            : undefined
      const path =
        typeof options === "object" && options !== null && "path" in options
          ? options.path
          : typeof options === "string" && !/^\d+$/.test(options)
            ? options
            : undefined
      // HTTP agents pass path:null for TCP. Only a real IPC path bypasses the
      // host check; null/empty path must not grant external network access.
      if (
        !(typeof path === "string" && path.length > 0) &&
        host !== undefined &&
        host !== "127.0.0.1" &&
        host !== "::1" &&
        host !== "localhost"
      ) {
        blocked.push(String(host))
        throw new Error(
          "External network is disabled in tests. Inject a fake transport.",
        )
      }
      return (originalConnect as Connect).apply(this, args)
    },
    takeBlockedHosts() {
      return blocked.splice(0)
    },
  }
}
