import { EventEmitter } from "node:events"
import { beforeEach, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { openChatGPTAuthorization } from "../../src/server/chatgpt-browser.ts"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
beforeEach(() => {
  vi.mocked(spawn).mockReset()
  vi.mocked(spawn).mockImplementation(() => {
    const process = new EventEmitter()
    queueMicrotask(() => process.emit("exit", 0))
    return process as ReturnType<typeof spawn>
  })
})
it("opens only the exact official authorization route without a shell or renderer handoff", async () => {
  const url =
    "https://auth.openai.com/api/accounts/authorize?client_id=oaiapp_fixture&id_token_hint=fake"
  await openChatGPTAuthorization(url)
  expect(spawn).toHaveBeenCalledWith(
    process.platform === "darwin"
      ? "/usr/bin/open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open",
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { shell: false, stdio: "ignore" },
  )
})
it.each([
  "https://evil.example/auth",
  "https://auth.openai.com/other",
  "http://auth.openai.com/api/accounts/authorize",
  "https://user@auth.openai.com/api/accounts/authorize",
])("rejects an unsafe authorization destination %s", async (url) => {
  await expect(openChatGPTAuthorization(url)).rejects.toThrow("destination")
  expect(spawn).not.toHaveBeenCalled()
})
it("redacts subprocess errors that could contain the secret-bearing URL", async () => {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit("error", new Error("id_token_hint=secret")))
    return child as ReturnType<typeof spawn>
  })
  await expect(
    openChatGPTAuthorization("https://auth.openai.com/api/accounts/authorize"),
  ).rejects.toThrow("The system browser could not be opened.")
})
