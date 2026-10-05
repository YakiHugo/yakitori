import type { Socket } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { createTestNetworkGuard } from "../support/test-network-guard.ts"

// Exercise the guard with an in-memory original, never a live socket.
describe("test network isolation", () => {
  it.each([
    undefined,
    null,
    "",
  ])("blocks HTTP/HTTPS TCP options with path %s", (path) => {
    const original = vi.fn(() => ({}) as Socket)
    const guard = createTestNetworkGuard(original)
    for (const port of [80, 443]) {
      expect(() =>
        guard.connect.call({} as Socket, {
          host: "external.invalid",
          port,
          path,
        }),
      ).toThrow("External network is disabled")
    }
    expect(original).not.toHaveBeenCalled()
    // The setup assertion still detects an attempt when application code
    // catches its failure and silently serves a cached/fallback result.
    expect(guard.takeBlockedHosts()).toEqual([
      "external.invalid",
      "external.invalid",
    ])
    expect(guard.takeBlockedHosts()).toEqual([])
  })
  it("handles normalized net arguments and the numeric host overload", () => {
    const original = vi.fn(() => ({}) as Socket)
    const guard = createTestNetworkGuard(original)
    expect(() =>
      guard.connect.call({} as Socket, [
        { host: "external.invalid", port: 443, path: null },
      ]),
    ).toThrow()
    expect(() =>
      guard.connect.call({} as Socket, 443, "external.invalid"),
    ).toThrow()
    expect(original).not.toHaveBeenCalled()
  })
  it("delegates loopback and IPC connections without changing the arguments", () => {
    const socket = {} as Socket
    const original = vi.fn(() => socket)
    const guard = createTestNetworkGuard(original)
    for (const host of ["127.0.0.1", "::1", "localhost", undefined]) {
      const options = { host, port: 1234, path: null }
      expect(guard.connect.call(socket, options)).toBe(socket)
      expect(original).toHaveBeenLastCalledWith(options)
    }
    expect(guard.connect.call(socket, { path: "/tmp/fixture.sock" })).toBe(
      socket,
    )
    expect(guard.takeBlockedHosts()).toEqual([])
  })
})
