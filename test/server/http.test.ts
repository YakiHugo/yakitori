import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createYakitoriHttpServer,
  type YakitoriHttpServerOptions,
  type YakitoriStaticAssets,
} from "../../src/server/http.ts"
import { ApiErrorCode } from "../../src/server/protocol.ts"
import { createRequestGate } from "../../src/server/request-gate.ts"
import { createFakeHandlers } from "./rpc/testkit.ts"

// The REST+SSE API is gone: /rpc (WebSocket JSON-RPC) is the only API
// channel. These tests pin the remaining HTTP surface — health, static GUI
// assets with the SPA fallback, CORS — and that the old routes stay gone.

describe("HTTP server", () => {
  it("requires an injected runtime instead of opening persistence implicitly", () => {
    expect(() =>
      createYakitoriHttpServer({} as YakitoriHttpServerOptions),
    ).toThrow("createYakitoriApplication")
  })

  it("answers the health probe", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    })
  })

  it("returns explicit JSON errors for removed API routes", async () => {
    await withHttpServer(async (baseUrl) => {
      for (const [method, path] of [
        ["GET", "/sessions"],
        ["POST", "/sessions"],
        ["GET", "/sessions/session_1"],
        ["DELETE", "/sessions/session_1"],
        ["GET", "/sessions/session_1/events?after=0"],
        ["POST", "/sessions/session_1/inputs"],
        ["POST", "/sessions/session_1/compact"],
        ["POST", "/sessions/session_1/turns/turn_1/cancel"],
        [
          "POST",
          "/sessions/session_1/turns/turn_1/permissions/perm_1/resolve",
        ],
        ["GET", "/projects"],
        ["POST", "/projects"],
        ["GET", "/providers"],
        ["PUT", "/user-preference"],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}`, { method })
        expect(response.status, `${method} ${path}`).toBe(404)
        expect(await response.json()).toEqual({
          error: {
            code: ApiErrorCode.NotFound,
            message: "Route not found.",
          },
        })
      }
    })
  })

  it("rejects non-loopback CORS origins", async () => {
    await withHttpServer(async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://example.com" },
      })

      expect(rejected.status).toBe(403)
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull()
      expect(await rejected.json()).toEqual({
        error: {
          code: ApiErrorCode.Forbidden,
          message: "Origin is not allowed.",
        },
      })

      const allowed = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "http://127.0.0.1:5173" },
      })

      expect(allowed.status).toBe(200)
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "http://127.0.0.1:5173",
      )
    })
  })

  it("answers CORS preflights", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:5173",
      )
    })
  })

  it("holds its request gate token until a response finishes", async () => {
    const gate = createRequestGate()
    const endCalled = deferred<void>()
    let releaseResponse: (() => void) | undefined
    const server = createYakitoriHttpServer({
      handlers: createFakeHandlers(),
      requestGate: gate,
    })
    server.prependListener("request", (_request, response) => {
      const originalEnd = response.end.bind(response)
      response.end = ((...args: unknown[]) => {
        releaseResponse = () => {
          Reflect.apply(originalEnd, response, args)
        }
        endCalled.resolve()
        return response
      }) as typeof response.end
    })

    await withListeningServer(server, async (baseUrl) => {
      const response = fetch(`${baseUrl}/health`)
      await endCalled.promise
      gate.close()
      let drained = false
      const shutdown = gate.shutdown().then(() => {
        drained = true
      })
      await Promise.resolve()

      expect(drained).toBe(false)

      releaseResponse?.()
      expect((await response).status).toBe(200)
      await shutdown
      expect(drained).toBe(true)
    })
  })

  it("returns the JSON 404 for unknown paths without static assets", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`)

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })
})

const staticIndexHtml = "<!doctype html><html><body>yakitori</body></html>"
const staticAssetJs = "console.log('yakitori')\n"
const staticSecret = "top secret\n"

describe("HTTP static assets", () => {
  it("serves index.html at the root with revalidation", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      )
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe(staticIndexHtml)
    })
  })

  it("serves hashed assets with an immutable cache header", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/assets/app-abc123.js`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      )
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      )
      expect(await response.text()).toBe(staticAssetJs)
    })
  })

  it("falls back to index.html for unknown client-side routes", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/missing-page`)

      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toBe(staticIndexHtml)
    })
  })

  it("keeps JSON 404s for removed API routes even with static assets", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      for (const [method, path] of [
        ["GET", "/sessions"],
        ["POST", "/sessions"],
        ["GET", "/sessions/unknown"],
        ["GET", "/sessions/unknown/events"],
        ["GET", "/projects"],
        ["GET", "/providers"],
        ["PUT", "/user-preference"],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}`, { method })
        expect(response.status, `${method} ${path}`).toBe(404)
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        )
      }

      const post = await fetch(`${baseUrl}/missing-page`, { method: "POST" })
      expect(post.status).toBe(404)
      expect(await post.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })

  it("never serves files outside the static directory", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
        const response = await fetch(`${baseUrl}${path}`)

        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).not.toContain(staticSecret)
        expect(body).toBe(staticIndexHtml)
      }
    })
  })

  it("never serves files through symlinks escaping the static directory", async () => {
    await withStaticHttpServer(async (baseUrl, paths) => {
      try {
        await symlink(
          join(paths.rootDir, "secret.txt"),
          join(paths.staticDir, "leak.txt"),
        )
      } catch {
        // Symlink creation needs extra privileges on some platforms.
        return
      }

      const response = await fetch(`${baseUrl}/leak.txt`)

      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toContain(staticSecret)
      expect(body).toBe(staticIndexHtml)
    })
  })

  it("falls back to the SPA for near-miss API prefixes", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      for (const path of ["/sessionsettings", "/healthcheck"]) {
        const response = await fetch(`${baseUrl}${path}`)

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        )
        expect(await response.text()).toBe(staticIndexHtml)
      }
    })
  })

  it("routes encoded API segments like decoded ones", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/%73essions/nope/extra`)

      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({
        error: {
          code: ApiErrorCode.NotFound,
          message: "Route not found.",
        },
      })
    })
  })

  it("keeps the JSON 404 for HEAD requests", async () => {
    await withStaticHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`, { method: "HEAD" })

      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
    })
  })
})

async function withHttpServer(
  run: (baseUrl: string) => Promise<void>,
  options?: { readonly staticAssets?: YakitoriStaticAssets },
): Promise<void> {
  await withListeningServer(
    createYakitoriHttpServer({
      handlers: createFakeHandlers(),
      ...options,
    }),
    run,
  )
}

async function withStaticHttpServer(
  run: (
    baseUrl: string,
    paths: { readonly staticDir: string; readonly rootDir: string },
  ) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "yakitori-static-"))
  const staticDir = join(rootDir, "site")
  try {
    await mkdir(join(staticDir, "assets"), { recursive: true })
    await writeFile(join(staticDir, "index.html"), staticIndexHtml)
    await writeFile(join(staticDir, "assets", "app-abc123.js"), staticAssetJs)
    await writeFile(join(rootDir, "secret.txt"), staticSecret)
    await withHttpServer((baseUrl) => run(baseUrl, { staticDir, rootDir }), {
      staticAssets: { directory: staticDir },
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function withListeningServer(
  server: ReturnType<typeof createYakitoriHttpServer>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = server.address()
    if (!isAddressInfo(address)) throw new Error("Expected TCP address.")
    await run(`http://${address.address}:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
      server.closeAllConnections()
    })
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "address" in value &&
    "port" in value
  )
}
