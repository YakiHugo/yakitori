import { createHash } from "node:crypto"
import type {
  DesktopBuildInfo,
  DesktopUpdateRelease,
} from "../protocol/desktop-update.ts"

export type ResolvedDesktopUpdate = {
  release: DesktopUpdateRelease
  build: DesktopBuildInfo
  archive: DesktopUpdateArchive
}

export type DesktopUpdateChunk = {
  offset: number
  size: number
  sha256: string
  /** Regular file path relative to the installed .app, never an archive path. */
  sourcePath?: string
  sourceOffset?: number
  /** Authenticated tar metadata bytes; regular file payloads use source mapping. */
  data?: string
}

export type DesktopUpdateArchive = {
  url: string
  sha256: string
  size: number
  chunks?: DesktopUpdateChunk[]
}

// Implementation safety boundaries: bound per-chunk RAM, metadata parsing, and
// filesystem work while allowing substantially more files than a packaged app.
export const desktopUpdateChunkSizeLimit = 4 * 1024 * 1024
export const desktopUpdateChunkCountLimit = 100_000
export const desktopUpdateManifestSizeLimit = 32 * 1024 * 1024

const repository = "YakiHugo/yakitori"
const archiveName = "yakitori-macos-arm64.tar"
const manifestName = "update-manifest.json"
// Implementation safety boundaries: discovery needs only 20 release records and
// an identity/hash/chunk manifest. Bound bytes even without Content-Length.
const releasePayloadLimit = 2 * 1024 * 1024
const manifestPayloadLimit = desktopUpdateManifestSizeLimit
const metadataTimeoutMs = 20_000

type ReleaseAsset = {
  name: string
  size: number
  url: string
  digest: string | undefined
}

export async function findDesktopUpdate(
  current: DesktopBuildInfo,
  options: { fetch?: typeof fetch } = {},
): Promise<ResolvedDesktopUpdate | undefined> {
  parseDesktopBuildInfo(current)
  const request = options.fetch ?? fetch
  const apiUrl = `https://api.github.com/repos/${current.repository}/releases?per_page=20`
  const payload = await fetchBytes(
    request,
    apiUrl,
    releasePayloadLimit,
    "GitHub release discovery",
    "application/vnd.github+json",
  )
  const releases: unknown = parseJson(payload, "GitHub release list")
  if (!Array.isArray(releases)) {
    throw new Error("GitHub release list must be an array.")
  }
  const candidates = releases.flatMap((value: unknown) => {
    const release = record(value, "GitHub release")
    if (typeof release.tag_name !== "string") {
      throw new Error("GitHub release tag is missing.")
    }
    if (
      !release.tag_name.startsWith("desktop-main-") ||
      release.draft === true
    ) {
      return []
    }
    const match = /^desktop-main-([1-9]\d*)-([1-9]\d*)$/.exec(release.tag_name)
    if (!match || release.draft !== false || release.prerelease !== true) {
      throw new Error(
        "Desktop main release must be a tagged, public prerelease.",
      )
    }
    const buildNumber = positiveInteger(
      Number(match[1]),
      "release build number",
    )
    const buildAttempt = positiveInteger(
      Number(match[2]),
      "release build attempt",
    )
    return [{ release, buildNumber, buildAttempt }]
  })
  candidates.sort(
    (a, b) => b.buildNumber - a.buildNumber || b.buildAttempt - a.buildAttempt,
  )
  const candidate = candidates[0]
  if (!candidate) return undefined
  const { release, buildNumber, buildAttempt } = candidate
  const tag = `desktop-main-${buildNumber}-${buildAttempt}`
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`
  if (release.html_url !== releaseUrl) {
    throw new Error(
      "Desktop release URL does not match its trusted GitHub tag.",
    )
  }
  if (
    typeof release.published_at !== "string" ||
    !validTimestamp(release.published_at)
  ) {
    throw new Error("Desktop release publication timestamp is invalid.")
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("Desktop release assets are missing.")
  }
  const assets = release.assets.map((asset: unknown) =>
    record(asset, "GitHub release asset"),
  )
  const manifestAsset = readAsset(assets, manifestName, tag)
  const archiveAsset = readAsset(assets, archiveName, tag)
  const manifestBytes = await fetchBytes(
    request,
    manifestAsset.url,
    manifestPayloadLimit,
    "Desktop update manifest",
    "application/octet-stream",
  )
  if (manifestBytes.byteLength !== manifestAsset.size) {
    throw new Error(
      "Desktop update manifest size differs from its GitHub asset.",
    )
  }
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex")
  if (manifestAsset.digest && manifestHash !== manifestAsset.digest) {
    throw new Error("Desktop update manifest failed its GitHub SHA256 digest.")
  }
  const manifest = record(
    parseJson(manifestBytes, "Desktop update manifest"),
    "Desktop update manifest",
  )
  if (manifest.formatVersion !== 1) {
    throw new Error("Desktop update manifest formatVersion must be 1.")
  }
  const build = parseDesktopBuildInfo(manifest.build)
  if (build.channel !== "main" || build.dirty) {
    throw new Error("Published desktop builds must be clean main builds.")
  }
  if (
    build.buildNumber !== buildNumber ||
    build.buildAttempt !== buildAttempt ||
    release.target_commitish !== build.commit
  ) {
    throw new Error(
      "Desktop release tag or commit differs from its build identity.",
    )
  }
  const archive = record(manifest.archive, "Desktop update archive")
  if (
    archive.name !== archiveName ||
    typeof archive.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    archive.size !== archiveAsset.size
  ) {
    throw new Error("Desktop update archive name, SHA256, or size is invalid.")
  }
  if (archiveAsset.digest && archive.sha256 !== archiveAsset.digest) {
    throw new Error(
      "Desktop update archive differs from its GitHub SHA256 digest.",
    )
  }
  const chunks =
    archive.chunks === undefined
      ? undefined
      : parseDesktopUpdateChunks(archive.chunks, archiveAsset.size)
  if (chunks && !manifestAsset.digest) {
    throw new Error("Chunk manifests require their GitHub SHA256 asset digest.")
  }
  const newer =
    current.channel === "main"
      ? buildNumber > current.buildNumber ||
        (buildNumber === current.buildNumber &&
          buildAttempt > current.buildAttempt)
      : current.dirty || current.commit !== build.commit
  if (!newer) return undefined
  return {
    release: {
      version: build.version,
      commit: build.commit,
      buildNumber,
      buildAttempt,
      publishedAt: release.published_at,
      releaseUrl,
    },
    build,
    // HTTPS GitHub is the trust root. These are integrity hashes from that
    // release, not an independent signature or an EdDSA-signed archive.
    archive: {
      url: archiveAsset.url,
      sha256: archive.sha256,
      size: archiveAsset.size,
      ...(chunks ? { chunks } : {}),
    },
  }
}

export function parseDesktopUpdateChunks(
  value: unknown,
  archiveSize: number,
): DesktopUpdateChunk[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > desktopUpdateChunkCountLimit
  ) {
    throw new Error("Desktop update chunk count exceeds its safety boundary.")
  }
  let offset = 0
  const chunks = value.map((entry: unknown): DesktopUpdateChunk => {
    const chunk = record(entry, "Desktop update chunk")
    const size = positiveInteger(chunk.size, "Desktop update chunk size")
    if (
      chunk.offset !== offset ||
      size > desktopUpdateChunkSizeLimit ||
      offset + size > archiveSize ||
      typeof chunk.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256)
    ) {
      throw new Error("Desktop update chunks must safely cover the archive.")
    }
    offset += size
    if (chunk.data !== undefined) {
      if (chunk.sourcePath !== undefined || chunk.sourceOffset !== undefined)
        throw new Error("Inline chunk source path and offset must be absent.")
      if (
        typeof chunk.data !== "string" ||
        chunk.data.length !== 4 * Math.ceil(size / 3)
      )
        throw new Error("Inline chunk data size or base64 encoding is invalid.")
      const bytes = Buffer.from(chunk.data, "base64")
      if (
        bytes.length !== size ||
        bytes.toString("base64") !== chunk.data ||
        createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
      )
        throw new Error(
          "Inline chunk data failed canonical base64 or SHA256 verification.",
        )
      return {
        offset: chunk.offset as number,
        size,
        sha256: chunk.sha256,
        data: chunk.data,
      }
    }
    if (chunk.sourcePath === undefined && chunk.sourceOffset === undefined) {
      return { offset: chunk.offset as number, size, sha256: chunk.sha256 }
    }
    if (
      typeof chunk.sourcePath !== "string" ||
      !safeDesktopUpdateSourcePath(chunk.sourcePath) ||
      typeof chunk.sourceOffset !== "number" ||
      !Number.isSafeInteger(chunk.sourceOffset) ||
      chunk.sourceOffset < 0 ||
      !Number.isSafeInteger(chunk.sourceOffset + size)
    ) {
      throw new Error("Desktop update chunk source path or offset is unsafe.")
    }
    return {
      offset: chunk.offset as number,
      size,
      sha256: chunk.sha256,
      sourcePath: chunk.sourcePath,
      sourceOffset: chunk.sourceOffset,
    }
  })
  if (offset !== archiveSize) {
    throw new Error("Desktop update chunks must cover the complete archive.")
  }
  return chunks
}

export function safeDesktopUpdateSourcePath(value: string): boolean {
  // 4 KiB bounds metadata/path work; paths use portable POSIX separators.
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    ![...value].some(
      (character) =>
        character === "\\" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    ) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  )
}

function readAsset(
  assets: Record<string, unknown>[],
  name: string,
  tag: string,
): ReleaseAsset {
  const matches = assets.filter((asset) => asset.name === name)
  const asset = matches[0]
  if (matches.length !== 1 || !asset || asset.state !== "uploaded") {
    throw new Error(`Desktop release must contain one uploaded ${name} asset.`)
  }
  const size = positiveInteger(asset.size, `${name} size`)
  const url = asset.browser_download_url ?? asset.url
  if (typeof url !== "string") {
    throw new Error(`Desktop release ${name} download URL is missing.`)
  }
  const parsed = new URL(url)
  const browserPath = `/${repository}/releases/download/${tag}/${name}`
  const apiPath = new RegExp(`^/repos/${repository}/releases/assets/[1-9]\\d*$`)
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !(
      (parsed.hostname === "github.com" && parsed.pathname === browserPath) ||
      (parsed.hostname === "api.github.com" && apiPath.test(parsed.pathname))
    )
  ) {
    throw new Error(
      `Desktop release ${name} URL is outside its trusted GitHub asset path.`,
    )
  }
  let digest: string | undefined
  if (asset.digest !== undefined && asset.digest !== null) {
    if (
      typeof asset.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    ) {
      throw new Error(`Desktop release ${name} GitHub digest is invalid.`)
    }
    digest = asset.digest.slice("sha256:".length)
  }
  return { name, size, url, digest }
}

export function parseDesktopBuildInfo(value: unknown): DesktopBuildInfo {
  const build = record(value, "Desktop build identity")
  if (
    build.repository !== repository ||
    typeof build.version !== "string" ||
    build.version.length === 0 ||
    typeof build.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(build.commit) ||
    typeof build.dirty !== "boolean" ||
    (build.channel !== "local" && build.channel !== "main") ||
    typeof build.builtAt !== "string" ||
    !validTimestamp(build.builtAt) ||
    build.platform !== "darwin" ||
    build.arch !== "arm64"
  ) {
    throw new Error(
      "Desktop build identity is invalid or outside the trusted repository/platform.",
    )
  }
  const minimum = build.channel === "main" ? 1 : 0
  if (
    typeof build.buildNumber !== "number" ||
    !Number.isSafeInteger(build.buildNumber) ||
    build.buildNumber < minimum ||
    typeof build.buildAttempt !== "number" ||
    !Number.isSafeInteger(build.buildAttempt) ||
    build.buildAttempt < minimum
  ) {
    throw new Error(
      "Desktop build must have valid run numbers; published builds must be clean main builds.",
    )
  }
  return {
    repository: build.repository,
    version: build.version,
    commit: build.commit,
    dirty: build.dirty,
    channel: build.channel,
    buildNumber: build.buildNumber,
    buildAttempt: build.buildAttempt,
    builtAt: build.builtAt,
    platform: build.platform,
    arch: build.arch,
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON.`, { cause: error })
  }
}

async function fetchBytes(
  request: typeof fetch,
  url: string,
  limit: number,
  label: string,
  accept: string,
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await request(url, {
      headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(metadataTimeoutMs),
      // Asset endpoints may redirect to GitHub's signed storage URLs. The
      // initial URL is checked against the fixed HTTPS repository boundary.
      redirect:
        url.startsWith("https://api.github.com/repos/") &&
        url.includes("/releases?")
          ? "error"
          : "follow",
    })
  } catch (error) {
    throw new Error(
      `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `${label} was denied or rate limited by GitHub (HTTP ${response.status}). Try again later.`,
      )
    }
    throw new Error(`${label} failed (HTTP ${response.status}).`)
  }
  const declaredSize = response.headers.get("content-length")
  if (
    declaredSize !== null &&
    (!/^\d+$/.test(declaredSize) || Number(declaredSize) > limit)
  ) {
    await response.body?.cancel()
    throw new Error(`${label} exceeds its ${limit}-byte metadata safety bound.`)
  }
  if (!response.body) throw new Error(`${label} response body is missing.`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error(
          `${label} exceeds its ${limit}-byte metadata safety bound.`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
