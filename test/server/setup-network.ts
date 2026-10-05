import { Socket } from "node:net"
import { afterEach, expect } from "vitest"
import { createTestNetworkGuard } from "../support/test-network-guard.ts"

// Integration tests may use local HTTP/WebSocket fixtures, never live accounts.
// Catch attempts below fetch mocks/SDKs, including failures swallowed by
// background discovery. A missed mock must fail the test instead of refreshing
// developer or fixture credentials against the real issuer.
const guard = createTestNetworkGuard(Socket.prototype.connect)
Socket.prototype.connect = guard.connect as Socket["connect"]
afterEach(() => {
  expect(
    guard.takeBlockedHosts(),
    "Tests attempted an external socket connection",
  ).toEqual([])
})
