import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { readCodexLogin } from "../../src/runtime/codex-credentials.ts"
import { LoginRequiredError } from "../../src/runtime/login-required.ts"
import { createSubscriptionAccountStore } from "../../src/server/subscription-accounts.ts"

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yakitori-account-import-"))
  directories.push(root)
  const cli = join(root, "cli")
  await mkdir(cli)
  vi.stubEnv("CODEX_HOME", cli)
  vi.stubEnv("GROK_CREDENTIALS", join(root, "missing-grok.json"))
  const directory = join(root, "accounts")
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      access_token: "verified-access",
      refresh_token: "rotated-refresh",
    }),
  )
  return {
    cli,
    directory,
    fetchFn,
    store: createSubscriptionAccountStore(directory, fetchFn),
  }
}
const exported = JSON.stringify({
  tokens: {
    access_token: "exported-access",
    refresh_token: "exported-refresh",
    account_id: "account-1",
  },
})

it("refreshes a file import with ChatGPT and persists only the validated login across restart", async () => {
  const { cli, directory, fetchFn, store } = await fixture()
  const original = join(cli, "auth.json")
  await writeFile(original, exported)
  const binding = await store.importAccount("codex", exported)
  expect(fetchFn).toHaveBeenCalledWith(
    "https://auth.openai.com/oauth/token",
    expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"refresh_token":"exported-refresh"'),
    }),
  )
  expect(await readFile(original, "utf8")).toBe(exported)
  const path = binding.credentialPath
  expect(await readCodexLogin({ path })).toMatchObject({
    kind: "chatgpt",
    accessToken: "verified-access",
    refreshToken: "rotated-refresh",
    accountId: "account-1",
  })
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readdir(directory)).toEqual([path.split("/").at(-1)])
})

it("retains the connected account when a new file is rejected by ChatGPT", async () => {
  const { directory, fetchFn, store } = await fixture()
  const { credentialPath: path } = await store.importAccount("codex", exported)
  const previous = await readFile(path, "utf8")
  fetchFn.mockResolvedValueOnce(
    new Response("secret echoed by vendor", { status: 401 }),
  )
  await expect(store.importAccount("codex", exported)).rejects.toThrow(
    "HTTP 401",
  )
  expect(await readFile(path, "utf8")).toBe(previous)
  expect(await readdir(directory)).toEqual([path.split("/").at(-1)])
})

it("reports missing local accounts and API-key logins instead of claiming subscription success", async () => {
  const { cli, fetchFn, store } = await fixture()
  await expect(store.importAccount("codex")).rejects.toThrow(
    "No ChatGPT account found",
  )
  await expect(store.importAccount("grok")).rejects.toThrow(
    "credentials not found",
  )
  await writeFile(
    join(cli, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "test-api-key" }),
  )
  await expect(store.importAccount("codex")).rejects.toThrow(
    "Add it under OpenAI",
  )
  expect(fetchFn).not.toHaveBeenCalled()
})

it("connects a local CLI account without rotating or copying its credentials", async () => {
  const { cli, store, fetchFn } = await fixture()
  await store.importAccount("codex", exported)
  const fresh = JSON.stringify({
    ...JSON.parse(exported),
    last_refresh: new Date().toISOString(),
  })
  await writeFile(join(cli, "auth.json"), fresh)
  fetchFn.mockClear()
  const binding = await store.importAccount("codex")
  expect(binding).toEqual({
    credentialPath: join(cli, "auth.json"),
    credentialOwner: "account-1",
  })
  expect(await readFile(join(cli, "auth.json"), "utf8")).toBe(fresh)
  expect(fetchFn).not.toHaveBeenCalled()
})

it("accepts a single ChatGPT export and rejects malformed JSON without echoing secrets", async () => {
  const { store, fetchFn } = await fixture()
  const binding = await store.importAccount(
    "codex",
    JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      account_id: "export-account",
    }),
  )
  expect(await readCodexLogin({ path: binding.credentialPath })).toMatchObject({
    accountId: "export-account",
  })
  fetchFn.mockClear()
  await expect(
    store.importAccount("codex", '"very-sensitive-token'),
  ).rejects.toThrow(/^The account file is invalid JSON\.$/)
  await expect(
    store.importAccount("codex", '{"OPENAI_API_KEY":"sensitive"}'),
  ).rejects.toThrow("API keys belong under OpenAI")
  expect(fetchFn).not.toHaveBeenCalled()
})

it("refreshes expired local credentials in their original file before binding the account", async () => {
  const { cli, directory, store, fetchFn } = await fixture()
  const path = join(cli, "auth.json")
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`
  await writeFile(
    path,
    JSON.stringify({
      tokens: {
        access_token: expiredToken,
        refresh_token: "local-refresh",
        account_id: "account-1",
      },
      last_refresh: new Date().toISOString(),
    }),
  )
  expect(await store.importAccount("codex")).toEqual({
    credentialPath: path,
    credentialOwner: "account-1",
  })
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(await readCodexLogin({ path })).toMatchObject({
    accessToken: "verified-access",
    refreshToken: "rotated-refresh",
  })
  await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" })
})

it("distinguishes vendor-revoked credentials from temporary refresh failures", async () => {
  const { cli, store, fetchFn } = await fixture()
  const path = join(cli, "auth.json")
  await writeFile(path, exported)
  for (const response of [
    new Response("do not expose", { status: 401 }),
    Response.json({ error: { code: "refresh_token_reused" } }, { status: 400 }),
  ]) {
    fetchFn.mockResolvedValueOnce(response)
    await expect(store.importAccount("codex")).rejects.toBeInstanceOf(
      LoginRequiredError,
    )
  }
  fetchFn.mockResolvedValueOnce(new Response("do not expose", { status: 503 }))
  const result = store.importAccount("codex")
  await expect(result).rejects.toThrow("HTTP 503")
  await expect(result).rejects.not.toBeInstanceOf(LoginRequiredError)
  expect(await readFile(path, "utf8")).toBe(exported)
})
