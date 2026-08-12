import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  readCodexLogin,
  resolveCodexAccessToken,
} from "../../src/runtime/codex-credentials.ts"

const chatgptAuth = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id-token",
    access_token: "stored-access-token",
    refresh_token: "stored-refresh-token",
    account_id: "account-1",
  },
  last_refresh: "2026-08-01T00:00:00.000Z",
}

async function withAuthFile(
  auth: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-codex-"))
  const path = join(directory, "auth.json")
  await writeFile(path, JSON.stringify(auth))
  try {
    await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("readCodexLogin", () => {
  it("parses a ChatGPT OAuth login", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      expect(await readCodexLogin({ path })).toEqual({
        kind: "chatgpt",
        accessToken: "stored-access-token",
        refreshToken: "stored-refresh-token",
        accountId: "account-1",
        lastRefresh: "2026-08-01T00:00:00.000Z",
      })
    })
  })

  it("parses an API-key login", async () => {
    await withAuthFile(
      { auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null },
      async (path) => {
        expect(await readCodexLogin({ path })).toEqual({
          kind: "apiKey",
          apiKey: "sk-test",
        })
      },
    )
  })

  it("returns undefined when no login file exists", async () => {
    expect(
      await readCodexLogin({ path: join(tmpdir(), "missing-codex-auth.json") }),
    ).toBeUndefined()
  })

  it("throws on malformed logins", async () => {
    for (const bad of [
      ["not", "a", "record"],
      { tokens: { access_token: "x" } },
      { auth_mode: "chatgpt" },
    ]) {
      await withAuthFile(bad, async (path) => {
        await expect(readCodexLogin({ path })).rejects.toThrow(
          /malformed|tokens/,
        )
      })
    }
  })
})

describe("resolveCodexAccessToken", () => {
  it("returns the stored token while the login is fresh", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi.fn()
      const token = await resolveCodexAccessToken({
        path,
        now: () => Date.parse("2026-08-05T00:00:00.000Z"),
        fetchFn: fetchFn as unknown as typeof fetch,
      })
      expect(token).toEqual({
        accessToken: "stored-access-token",
        accountId: "account-1",
      })
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  it("refreshes in memory once last_refresh is stale, never writing back", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const before = await readFile(path, "utf8")
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "fresh-access-token" })),
      ) as unknown as typeof fetch

      const token = await resolveCodexAccessToken({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })

      expect(token.accessToken).toBe("fresh-access-token")
      expect(token.accountId).toBe("account-1")
      expect(fetchFn).toHaveBeenCalledWith(
        "https://auth.openai.com/oauth/token",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            grant_type: "refresh_token",
            refresh_token: "stored-refresh-token",
          }),
        }),
      )
      // v1 never writes the login file back.
      expect(await readFile(path, "utf8")).toBe(before)
    })
  })

  it("treats a missing last_refresh as stale", async () => {
    const { last_refresh: _dropped, ...auth } = chatgptAuth
    await withAuthFile(auth, async (path) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "fresh-access-token" })),
      ) as unknown as typeof fetch
      const token = await resolveCodexAccessToken({
        path,
        now: () => Date.parse("2026-08-02T00:00:00.000Z"),
        fetchFn,
      })
      expect(token.accessToken).toBe("fresh-access-token")
    })
  })

  it("fails closed on refresh errors without leaking token material", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi.fn(
        async () => new Response("refresh_token_expired", { status: 401 }),
      ) as unknown as typeof fetch
      const attempt = resolveCodexAccessToken({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })
      await expect(attempt).rejects.toThrow("HTTP 401")
      await expect(attempt).rejects.not.toThrow("stored-refresh-token")
    })
  })

  it("rejects API-key logins for the ChatGPT token path", async () => {
    await withAuthFile(
      { auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null },
      async (path) => {
        await expect(resolveCodexAccessToken({ path })).rejects.toThrow(
          "API-key login",
        )
      },
    )
  })
})
