import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createCodexAuthProvider,
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

  it("refreshes and persists a stale shared login", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
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
      const persisted = JSON.parse(await readFile(path, "utf8"))
      expect(persisted.tokens).toMatchObject({
        access_token: "fresh-access-token",
        refresh_token: "stored-refresh-token",
      })
      expect(persisted.last_refresh).toBe("2026-08-10T00:00:00.000Z")
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

  it("does not corrupt the shared login with a malformed refreshed ID token", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const before = await readFile(path, "utf8")
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access-token",
              refresh_token: "rotated-refresh-token",
              id_token: "not-a-jwt",
            }),
          ),
      ) as unknown as typeof fetch

      await expect(
        resolveCodexAccessToken({
          path,
          now: () => Date.parse("2026-08-10T00:00:00.000Z"),
          fetchFn,
        }),
      ).rejects.toThrow("invalid ID token")
      expect(await readFile(path, "utf8")).toBe(before)
    })
  })

  it("rejects a canonical ID token whose claims Codex cannot deserialize", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const before = await readFile(path, "utf8")
      const badClaims = Buffer.from(JSON.stringify({ email: 123 })).toString(
        "base64url",
      )
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access-token",
              refresh_token: "rotated-refresh-token",
              id_token: `header.${badClaims}.signature`,
            }),
          ),
      ) as unknown as typeof fetch

      await expect(
        resolveCodexAccessToken({
          path,
          now: () => Date.parse("2026-08-10T00:00:00.000Z"),
          fetchFn,
        }),
      ).rejects.toThrow("invalid ID token")
      expect(await readFile(path, "utf8")).toBe(before)
    })
  })

  it("rejects null for Codex's non-optional FedRAMP claim", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const before = await readFile(path, "utf8")
      const badClaims = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {
            chatgpt_account_is_fedramp: null,
          },
        }),
      ).toString("base64url")
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access-token",
              refresh_token: "rotated-refresh-token",
              id_token: `header.${badClaims}.signature`,
            }),
          ),
      ) as unknown as typeof fetch

      await expect(
        resolveCodexAccessToken({
          path,
          now: () => Date.parse("2026-08-10T00:00:00.000Z"),
          fetchFn,
        }),
      ).rejects.toThrow("invalid ID token")
      expect(await readFile(path, "utf8")).toBe(before)
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

describe("Codex auth provider", () => {
  it("keeps a 401-refreshed token ahead of a still-fresh disk login", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "recovered-token" })),
      ) as unknown as typeof fetch
      const auth = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-05T00:00:00.000Z"),
        fetchFn,
      })

      expect((await auth.resolve()).accessToken).toBe("stored-access-token")
      auth.invalidate()
      expect((await auth.resolve({ forceRefresh: true })).accessToken).toBe(
        "recovered-token",
      )
      expect((await auth.resolve()).accessToken).toBe("recovered-token")
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  it("persists a refresh-token rotation across provider restarts", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "first-access",
              refresh_token: "rotated-refresh-token",
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "second-access" })),
        ) as unknown as typeof fetch
      const auth = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })

      expect((await auth.resolve()).accessToken).toBe("first-access")
      const persisted = JSON.parse(await readFile(path, "utf8"))
      expect(persisted.tokens).toMatchObject({
        access_token: "first-access",
        refresh_token: "rotated-refresh-token",
      })
      const restarted = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-10T00:00:01.000Z"),
        fetchFn: (() => {
          throw new Error("fresh persisted login must not refresh")
        }) as typeof fetch,
      })
      expect((await restarted.resolve()).accessToken).toBe("first-access")
      auth.invalidate()
      expect((await auth.resolve({ forceRefresh: true })).accessToken).toBe(
        "second-access",
      )
      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        "https://auth.openai.com/oauth/token",
        expect.objectContaining({
          body: expect.stringContaining("rotated-refresh-token"),
        }),
      )
    })
  })

  it("single-flights a stale shared login and caches the refreshed token", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "fresh-access-token" })),
      ) as unknown as typeof fetch
      const auth = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })

      const [first, second] = await Promise.all([
        auth.resolve(),
        auth.resolve(),
      ])
      const third = await auth.resolve()

      expect(first.accessToken).toBe("fresh-access-token")
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  it("serializes refresh without worker-pool deadlock across five owners", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      let finishRefresh!: (response: Response) => void
      const pendingRefresh = new Promise<Response>((resolve) => {
        finishRefresh = resolve
      })
      const fetchFn = vi.fn(() => pendingRefresh) as unknown as typeof fetch
      const owners = Array.from({ length: 5 }, () =>
        createCodexAuthProvider({
          path,
          now: () => Date.parse("2026-08-10T00:00:00.000Z"),
          fetchFn,
        }),
      )

      const [firstOwner, ...waitingOwners] = owners
      if (firstOwner === undefined) throw new Error("missing first owner")
      const firstAttempt = firstOwner.resolve()
      await waitFor(() => vi.mocked(fetchFn).mock.calls.length === 1)
      const waitingAttempts = waitingOwners.map((owner) => owner.resolve())
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fetchFn).toHaveBeenCalledTimes(1)
      finishRefresh(
        new Response(
          JSON.stringify({
            access_token: "shared-access",
            refresh_token: "shared-refresh",
          }),
        ),
      )

      await expect(
        Promise.all([firstAttempt, ...waitingAttempts]),
      ).resolves.toEqual(
        Array.from({ length: 5 }, () => ({
          accessToken: "shared-access",
          accountId: "account-1",
        })),
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
  })

  it("invalidates cached refreshes when the shared login identity changes", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "first-refresh" })),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "second-refresh" })),
        ) as unknown as typeof fetch
      const auth = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })

      expect((await auth.resolve()).accessToken).toBe("first-refresh")
      await writeFile(
        path,
        JSON.stringify({
          ...chatgptAuth,
          tokens: {
            ...chatgptAuth.tokens,
            access_token: "rotated-access-token",
            refresh_token: "rotated-refresh-token",
          },
        }),
      )

      expect((await auth.resolve()).accessToken).toBe("second-refresh")
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })
  })

  it("rejects an in-flight refresh when the shared login identity changes", async () => {
    await withAuthFile(chatgptAuth, async (path) => {
      let finishOldRefresh!: (response: Response) => void
      const oldRefresh = new Promise<Response>((resolve) => {
        finishOldRefresh = resolve
      })
      const fetchFn = vi
        .fn()
        .mockReturnValueOnce(oldRefresh)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "account-b-token" })),
        ) as unknown as typeof fetch
      const auth = createCodexAuthProvider({
        path,
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        fetchFn,
      })
      const oldAttempt = auth.resolve()
      const oldOutcome = oldAttempt.catch((error: unknown) => error)
      await waitFor(() => vi.mocked(fetchFn).mock.calls.length === 1)
      await writeFile(
        path,
        JSON.stringify({
          ...chatgptAuth,
          tokens: {
            ...chatgptAuth.tokens,
            access_token: "account-b-stored",
            refresh_token: "account-b-refresh",
            account_id: "account-b",
          },
        }),
      )

      const newAttempt = auth.resolve()
      finishOldRefresh(
        new Response(JSON.stringify({ access_token: "late-account-a-token" })),
      )
      await expect(newAttempt).resolves.toEqual({
        accessToken: "account-b-token",
        accountId: "account-b",
      })
      expect(await oldOutcome).toMatchObject({
        message: expect.stringContaining(
          "Codex login changed while credentials were refreshing",
        ),
      })
    })
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for test condition.")
}
