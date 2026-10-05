import { createServer } from "node:http"

// Bind before creating the OAuth attempt: the redirect uses this actual port.
// Only loopback navigation is accepted, and callback parameters are never echoed.
export async function createChatGPTLoopback(input: {
  callback(url: string): Promise<"accepted" | "invalid">
}) {
  let redirectUri = ""
  let completing = false
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Connection", "close")
    response.setHeader("Content-Type", "text/plain; charset=utf-8")
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    )
    response.setHeader("Referrer-Policy", "no-referrer")
    if (
      request.method !== "GET" ||
      request.headers.host !== new URL(redirectUri).host ||
      !request.url?.startsWith("/auth/callback?") ||
      request.url.length > 16_384 ||
      completing
    ) {
      response.writeHead(400).end("Invalid sign-in callback.")
      return
    }
    const callback = new URL(request.url, redirectUri)
    if (
      callback.origin !== new URL(redirectUri).origin ||
      callback.pathname !== "/auth/callback"
    ) {
      response.writeHead(400).end("Invalid sign-in callback.")
      return
    }
    completing = true
    void input.callback(callback.href).then(
      (result) => {
        response
          .writeHead(result === "accepted" ? 200 : 400)
          .end(
            result === "accepted"
              ? "Return to Yakitori to see your ChatGPT connection. You can close this tab."
              : "Invalid sign-in callback.",
          )
        completing = false
      },
      () => {
        response
          .writeHead(500)
          .end("Sign-in could not be completed. Return to Yakitori.")
        completing = false
      },
    )
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("ChatGPT callback listener could not be bound.")
  }
  redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
  return {
    redirectUri,
    async close(force = true) {
      if (force) server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
