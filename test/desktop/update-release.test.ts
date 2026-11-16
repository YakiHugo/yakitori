import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { prepareDesktopBuildInfo } from "../../scripts/build-desktop-info.ts"
import {
  desktopUpdateManifestSizeLimit,
  findDesktopUpdate,
  parseDesktopBuildInfo,
} from "../../src/desktop/update-release.ts"
import type { DesktopBuildInfo } from "../../src/protocol/desktop-update.ts"

const repository = "YakiHugo/yakitori"
const commit = "a".repeat(40)
const archiveHash = "b".repeat(64)
const tag = "desktop-main-42-2"
const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`
const archiveUrl = `https://github.com/${repository}/releases/download/${tag}/yakitori-macos-arm64.tar`
const manifestUrl = `https://github.com/${repository}/releases/download/${tag}/update-manifest.json`
const apiUrl = `https://api.github.com/repos/${repository}/releases?per_page=20`

function build(overrides: Partial<DesktopBuildInfo> = {}): DesktopBuildInfo {
  return {
    repository,
    version: "0.0.0",
    commit,
    dirty: false,
    channel: "main",
    buildNumber: 42,
    buildAttempt: 2,
    builtAt: "2026-11-15T01:02:03.000Z",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  }
}

function manifest() {
  return {
    formatVersion: 1,
    build: build(),
    archive: {
      name: "yakitori-macos-arm64.tar",
      sha256: archiveHash,
      size: 1234,
    },
  }
}

type FixtureAsset = {
  name: string
  state: string
  size: number
  url: string
  browser_download_url?: string
  digest?: string | null
}
type FixtureRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  html_url: string
  published_at: string
  target_commitish: string
  assets: FixtureAsset[]
}

function fixture(
  options: {
    manifest?: unknown
    manifestText?: string
    apiPayload?: unknown
    apiStatus?: number
    manifestStatus?: number
    editRelease?: (release: FixtureRelease) => void
  } = {},
) {
  const text =
    options.manifestText ?? JSON.stringify(options.manifest ?? manifest())
  const release: FixtureRelease = {
    tag_name: tag,
    draft: false,
    prerelease: true,
    html_url: releaseUrl,
    published_at: "2026-11-15T02:00:00Z",
    target_commitish: commit,
    assets: [
      {
        name: "update-manifest.json",
        state: "uploaded",
        size: Buffer.byteLength(text),
        url: `https://api.github.com/repos/${repository}/releases/assets/123`,
        browser_download_url: manifestUrl,
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      },
      {
        name: "yakitori-macos-arm64.tar",
        state: "uploaded",
        size: 1234,
        url: `https://api.github.com/repos/${repository}/releases/assets/124`,
        browser_download_url: archiveUrl,
        digest: `sha256:${archiveHash}`,
      },
    ],
  }
  options.editRelease?.(release)
  const requests: string[] = []
  const request: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(url)
    if (url === apiUrl) {
      return new Response(JSON.stringify(options.apiPayload ?? [release]), {
        status: options.apiStatus ?? 200,
      })
    }
    if (url === manifestUrl || url === release.assets[0]?.url) {
      return new Response(text, { status: options.manifestStatus ?? 200 })
    }
    throw new Error(`Unexpected HTTP request ${url}`)
  }
  return { fetch: request, requests }
}

describe("trusted GitHub desktop release discovery", () => {
  it("resolves the exact release archive and verifies both GitHub digests", async () => {
    const http = fixture()
    await expect(
      findDesktopUpdate(build({ buildAttempt: 1 }), http),
    ).resolves.toEqual({
      release: {
        version: "0.0.0",
        commit,
        buildNumber: 42,
        buildAttempt: 2,
        publishedAt: "2026-11-15T02:00:00Z",
        releaseUrl,
      },
      build: build(),
      archive: { url: archiveUrl, sha256: archiveHash, size: 1234 },
    })
    expect(http.requests).toEqual([apiUrl, manifestUrl])
  })

  it.each([
    { buildNumber: 41, buildAttempt: 99, update: true },
    { buildNumber: 42, buildAttempt: 1, update: true },
    { buildNumber: 42, buildAttempt: 2, update: false },
    { buildNumber: 42, buildAttempt: 3, update: false },
    { buildNumber: 43, buildAttempt: 1, update: false },
  ])("compares CI run $buildNumber attempt $buildAttempt numerically", async (value) => {
    const result = await findDesktopUpdate(
      build({
        buildNumber: value.buildNumber,
        buildAttempt: value.buildAttempt,
      }),
      fixture(),
    )
    expect(result !== undefined).toBe(value.update)
  })

  it.each([
    { commit, dirty: false, update: false },
    { commit, dirty: true, update: true },
    { commit: "c".repeat(40), dirty: false, update: true },
  ])("compares local commit and dirty status: $dirty / $commit", async (value) => {
    const result = await findDesktopUpdate(
      build({ channel: "local", buildNumber: 0, buildAttempt: 0, ...value }),
      fixture(),
    )
    expect(result !== undefined).toBe(value.update)
  })

  it("is idle when the public repository has no releases", async () => {
    const http = fixture({ apiPayload: [] })
    await expect(findDesktopUpdate(build(), http)).resolves.toBeUndefined()
    expect(http.requests).toEqual([apiUrl])
  })

  it("ignores unrelated releases and draft builds", async () => {
    const http = fixture({
      apiPayload: [
        { tag_name: "v1.0.0" },
        { tag_name: "desktop-main-900-1", draft: true },
      ],
    })
    await expect(findDesktopUpdate(build(), http)).resolves.toBeUndefined()
  })

  it("chooses the greatest CI identity instead of trusting list order", async () => {
    const http = fixture({
      apiPayload: [
        { tag_name: "desktop-main-41-99", draft: false, prerelease: true },
        {
          tag_name: tag,
          draft: false,
          prerelease: true,
          html_url: "https://evil.test",
        },
      ],
    })
    await expect(findDesktopUpdate(build(), http)).rejects.toThrow(
      /trusted GitHub tag/,
    )
  })

  it("accepts GitHub API asset URLs when browser URLs are absent", async () => {
    const http = fixture({
      editRelease: (release) => {
        for (const asset of release.assets) delete asset.browser_download_url
      },
    })
    const result = await findDesktopUpdate(build({ buildAttempt: 1 }), http)
    expect(result?.archive.url).toBe(
      `https://api.github.com/repos/${repository}/releases/assets/124`,
    )
    expect(http.requests[1]).toBe(
      `https://api.github.com/repos/${repository}/releases/assets/123`,
    )
  })

  it("anchors archive integrity to the trusted manifest when GitHub digests are absent", async () => {
    const http = fixture({
      editRelease: (release) => {
        for (const asset of release.assets) asset.digest = null
      },
    })
    expect(
      (await findDesktopUpdate(build({ buildAttempt: 1 }), http))?.archive
        .sha256,
    ).toBe(archiveHash)
  })

  it("authenticates chunk metadata larger than the old identity-only manifest bound", async () => {
    const chunks = Array.from({ length: 1234 }, (_, offset) => ({
      offset,
      size: 1,
      sha256: archiveHash,
    }))
    const value = { ...manifest(), archive: { ...manifest().archive, chunks } }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(16 * 1024)
    const result = await findDesktopUpdate(
      build({ buildAttempt: 1 }),
      fixture({ manifest: value }),
    )
    expect(result?.archive.chunks).toEqual(chunks)
  })

  it("preserves authenticated canonical inline metadata for transfer", async () => {
    const bytes = Buffer.alloc(1234, 0)
    const chunks = [
      {
        offset: 0,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes.toString("base64"),
      },
    ]
    const value = { ...manifest(), archive: { ...manifest().archive, chunks } }
    const result = await findDesktopUpdate(
      build({ buildAttempt: 1 }),
      fixture({ manifest: value }),
    )
    expect(result?.archive.chunks).toEqual(chunks)
  })

  it.each([
    [{ offset: 1, size: 1233, sha256: archiveHash }],
    [{ offset: 0, size: 1233, sha256: archiveHash }],
    [{ offset: 0, size: 1235, sha256: archiveHash }],
    [{ offset: 0, size: 0, sha256: archiveHash }],
    [{ offset: 0, size: 1234, sha256: "bad" }],
    [{ offset: 0, size: 1234, sha256: archiveHash, data: 123 }],
    [{ offset: 0, size: 1234, sha256: archiveHash, data: "a".repeat(1648) }],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        data: Buffer.alloc(1234).toString("base64"),
        sourcePath: "Contents/file",
        sourceOffset: 0,
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "../escape",
        sourceOffset: 0,
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "/absolute",
        sourceOffset: 0,
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "Contents\\file",
        sourceOffset: 0,
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "Contents/file",
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "Contents/file",
        sourceOffset: -1,
      },
    ],
    [
      {
        offset: 0,
        size: 1234,
        sha256: archiveHash,
        sourcePath: "Contents/file",
        sourceOffset: Number.MAX_SAFE_INTEGER,
      },
    ],
  ])("rejects unsafe or incomplete archive chunk metadata %#", async (chunk) => {
    const value = {
      ...manifest(),
      archive: { ...manifest().archive, chunks: [chunk] },
    }
    await expect(
      findDesktopUpdate(
        build({ buildAttempt: 1 }),
        fixture({ manifest: value }),
      ),
    ).rejects.toThrow(/chunk/)
  })

  it("requires a GitHub manifest digest before using chunk instructions", async () => {
    const value = {
      ...manifest(),
      archive: {
        ...manifest().archive,
        chunks: [{ offset: 0, size: 1234, sha256: archiveHash }],
      },
    }
    await expect(
      findDesktopUpdate(
        build({ buildAttempt: 1 }),
        fixture({
          manifest: value,
          editRelease: (release) => {
            const asset = release.assets[0]
            if (asset) asset.digest = null
          },
        }),
      ),
    ).rejects.toThrow(/require.*GitHub SHA256/)
  })

  it.each([
    [
      "foreign repository",
      { ...manifest(), build: { ...build(), repository: "other/repo" } },
    ],
    [
      "foreign architecture",
      { ...manifest(), build: { ...build(), arch: "x64" } },
    ],
    [
      "foreign platform",
      { ...manifest(), build: { ...build(), platform: "linux" } },
    ],
    [
      "abbreviated commit",
      { ...manifest(), build: { ...build(), commit: "abcdef" } },
    ],
    ["dirty build", { ...manifest(), build: { ...build(), dirty: true } }],
    ["local build", { ...manifest(), build: { ...build(), channel: "local" } }],
    ["tag mismatch", { ...manifest(), build: { ...build(), buildAttempt: 3 } }],
    [
      "string build number",
      { ...manifest(), build: { ...build(), buildNumber: "42" } },
    ],
    ["invalid format", { ...manifest(), formatVersion: 2 }],
    [
      "wrong archive name",
      { ...manifest(), archive: { ...manifest().archive, name: "other.tar" } },
    ],
    [
      "wrong archive size",
      { ...manifest(), archive: { ...manifest().archive, size: 4567 } },
    ],
    [
      "invalid archive hash",
      { ...manifest(), archive: { ...manifest().archive, sha256: "bad" } },
    ],
    [
      "GitHub archive hash mismatch",
      {
        ...manifest(),
        archive: { ...manifest().archive, sha256: "c".repeat(64) },
      },
    ],
  ])("rejects a manifest with %s", async (_label, value) => {
    await expect(
      findDesktopUpdate(
        build({ buildAttempt: 1 }),
        fixture({ manifest: value }),
      ),
    ).rejects.toThrow()
  })

  it.each([
    "https://evil.test/update-manifest.json",
    `http://github.com/${repository}/releases/download/${tag}/update-manifest.json`,
    `https://github.com/other/repo/releases/download/${tag}/update-manifest.json`,
    `https://github.com/${repository}/releases/download/wrong/update-manifest.json`,
    `https://github.com/${repository}/releases/download/${tag}/update-manifest.json?redirect=evil`,
    `https://github.com@evil.test/${repository}/releases/download/${tag}/update-manifest.json`,
  ])("rejects untrusted asset URL %s before fetching it", async (url) => {
    const http = fixture({
      editRelease: (release) => {
        const asset = release.assets[0]
        if (asset) asset.browser_download_url = url
      },
    })
    await expect(
      findDesktopUpdate(build({ buildAttempt: 1 }), http),
    ).rejects.toThrow(/trusted GitHub asset path/)
    expect(http.requests).toEqual([apiUrl])
  })

  it.each([
    [
      "missing archive",
      (release: FixtureRelease) => {
        release.assets.pop()
      },
    ],
    [
      "duplicate archive",
      (release: FixtureRelease) => {
        const asset = release.assets[1]
        if (asset) release.assets.push(asset)
      },
    ],
    [
      "commit mismatch",
      (release: FixtureRelease) => {
        release.target_commitish = "d".repeat(40)
      },
    ],
    [
      "non prerelease",
      (release: FixtureRelease) => {
        release.prerelease = false
      },
    ],
    [
      "invalid tag",
      (release: FixtureRelease) => {
        release.tag_name = "desktop-main-42-no"
      },
    ],
    [
      "invalid manifest digest",
      (release: FixtureRelease) => {
        const asset = release.assets[0]
        if (asset) asset.digest = "sha256:bad"
      },
    ],
    [
      "mismatched manifest digest",
      (release: FixtureRelease) => {
        const asset = release.assets[0]
        if (asset) asset.digest = `sha256:${"f".repeat(64)}`
      },
    ],
    [
      "mismatched manifest size",
      (release: FixtureRelease) => {
        const asset = release.assets[0]
        if (asset) asset.size += 1
      },
    ],
  ])("rejects malformed published source: %s", async (_label, editRelease) => {
    await expect(
      findDesktopUpdate(build({ buildAttempt: 1 }), fixture({ editRelease })),
    ).rejects.toThrow()
  })

  it.each([
    403, 429, 500, 404,
  ])("reports GitHub HTTP %s without falling back", async (status) => {
    const http = fixture({ apiStatus: status })
    await expect(findDesktopUpdate(build(), http)).rejects.toThrow(
      `HTTP ${status}`,
    )
    expect(http.requests).toEqual([apiUrl])
  })

  it("reports network failure with its cause", async () => {
    const request: typeof fetch = async () => {
      throw new TypeError("offline")
    }
    await expect(
      findDesktopUpdate(build(), { fetch: request }),
    ).rejects.toThrow(/request failed: offline/)
  })

  it("rejects malformed JSON instead of hiding the newest broken release", async () => {
    await expect(
      findDesktopUpdate(build(), fixture({ manifestText: "{" })),
    ).rejects.toThrow(/valid UTF-8 JSON/)
  })

  it("bounds streamed manifest bytes when Content-Length is absent", async () => {
    await expect(
      findDesktopUpdate(
        build(),
        fixture({
          manifestText: "x".repeat(desktopUpdateManifestSizeLimit + 1),
        }),
      ),
    ).rejects.toThrow(/metadata safety bound/)
  })

  it("bounds release API payload bytes", async () => {
    await expect(
      findDesktopUpdate(
        build(),
        fixture({ apiPayload: "x".repeat(2 * 1024 * 1024) }),
      ),
    ).rejects.toThrow(/metadata safety bound/)
  })

  it("rejects malformed local identity before requesting a source", async () => {
    const http = fixture()
    await expect(
      findDesktopUpdate(build({ repository: "other/repo" }), http),
    ).rejects.toThrow(/trusted repository/)
    expect(http.requests).toEqual([])
    expect(
      parseDesktopBuildInfo(
        build({ channel: "local", buildNumber: 0, buildAttempt: 0 }),
      ),
    ).toEqual(build({ channel: "local", buildNumber: 0, buildAttempt: 0 }))
  })
})

describe("desktop build identity from the checkout", () => {
  const roots: string[] = []
  const run = promisify(execFile)
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  async function checkout(remote = "git@github.com:YakiHugo/yakitori.git") {
    const root = await mkdtemp(join(tmpdir(), "yakitori-build-info-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}\n')
    await writeFile(join(root, ".gitignore"), "dist/\n")
    await run("git", ["init", "-q", root])
    await run("git", ["-C", root, "add", "."])
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Build test",
      "-c",
      "user.email=build@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ])
    await run("git", ["-C", root, "remote", "add", "origin", remote])
    return root
  }

  it("records local identity and ignores generated build output while detecting preexisting source changes", async () => {
    const cwd = await checkout()
    await mkdir(join(cwd, "dist"))
    await writeFile(join(cwd, "dist", "build-info.json"), "{}")
    const clean = await prepareDesktopBuildInfo({
      cwd,
      env: {},
      builtAt: new Date("2026-11-15T00:00:00Z"),
    })
    expect(clean).toMatchObject({
      repository,
      version: "1.2.3",
      channel: "local",
      dirty: false,
      buildNumber: 0,
      buildAttempt: 0,
      builtAt: "2026-11-15T00:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
    })
    expect(clean.commit).toMatch(/^[a-f0-9]{40}$/)
    await writeFile(join(cwd, "source.ts"), "export const changed = true\n")
    expect((await prepareDesktopBuildInfo({ cwd, env: {} })).dirty).toBe(true)
  })

  it.each([
    { event: "push", ref: "refs/heads/main", actions: "true", channel: "main" },
    {
      event: "pull_request",
      ref: "refs/pull/2/merge",
      actions: "true",
      channel: "local",
    },
    {
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      actions: "true",
      channel: "local",
    },
    {
      event: "push",
      ref: "refs/heads/main",
      actions: "false",
      channel: "local",
    },
  ])("uses channel $channel for $event on $ref ($actions)", async (value) => {
    const cwd = await checkout()
    const result = await prepareDesktopBuildInfo({
      cwd,
      env: {
        GITHUB_REPOSITORY: repository,
        GITHUB_ACTIONS: value.actions,
        GITHUB_EVENT_NAME: value.event,
        GITHUB_REF: value.ref,
        GITHUB_RUN_NUMBER: "123",
        GITHUB_RUN_ATTEMPT: "2",
      },
    })
    expect(result).toMatchObject({
      channel: value.channel,
      buildNumber: 123,
      buildAttempt: 2,
    })
  })

  it.each([
    "https://github.com/YakiHugo/yakitori.git",
    "ssh://git@github.com/YakiHugo/yakitori.git",
  ])("safely resolves GitHub origin %s", async (remote) => {
    const cwd = await checkout(remote)
    expect((await prepareDesktopBuildInfo({ cwd, env: {} })).repository).toBe(
      repository,
    )
  })

  it.each([
    "https://evil.test/YakiHugo/yakitori.git",
    "https://github.com/unknown/repository.git",
    "git@github.com:unknown/repository.git",
    "https://github.com/YakiHugo/yakitori.git?token=secret",
  ])("rejects an unknown or non-GitHub origin %s", async (remote) => {
    const cwd = await checkout(remote)
    await expect(prepareDesktopBuildInfo({ cwd, env: {} })).rejects.toThrow()
  })

  it("rejects malformed CI run numbers and untrusted repository overrides", async () => {
    const cwd = await checkout()
    await expect(
      prepareDesktopBuildInfo({ cwd, env: { GITHUB_RUN_NUMBER: "NaN" } }),
    ).rejects.toThrow(/positive integers/)
    await expect(
      prepareDesktopBuildInfo({
        cwd,
        env: { GITHUB_REPOSITORY: "unknown/repo" },
      }),
    ).rejects.toThrow(/require the YakiHugo/)
  })
})
