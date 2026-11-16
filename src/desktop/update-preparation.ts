import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
  sep,
} from "node:path"
import { promisify } from "node:util"
import type { DesktopBuildInfo } from "../protocol/desktop-update.ts"
import { signDesktopApplication } from "./app-signing.ts"
import { removeUpdateDirectory } from "./update-filesystem.ts"

const exec = promisify(execFile)
const nativeHelper = "Contents/Resources/computer/Yakitori Computer.app"

async function run(command: string, args: string[]) {
  try {
    return await exec(command, args, { maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    throw new Error(
      `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

// Tar paths are checked before extraction, including paths introduced by PAX.
// No archive member may traverse a symlink, even one declared later in the tar.
async function validateArchive(archivePath: string): Promise<void> {
  const archive = await open(archivePath, "r")
  try {
    const size = (await archive.stat()).size
    const members = new Map<string, string>()
    const links = new Map<string, string>()
    const key = (path: string) =>
      path.normalize("NFD").toUpperCase().toLowerCase()
    const unsafeCharacters = (path: string) =>
      [...path].some(
        (character) =>
          character === "\\" ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127,
      )
    let offset = 0
    let extended: Record<string, string> = {}
    let longName: string | undefined
    let longLink: string | undefined
    let count = 0
    const decode = (buffer: Buffer) =>
      new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    const field = (buffer: Buffer) =>
      decode(
        buffer.subarray(
          0,
          buffer.indexOf(0) < 0 ? undefined : buffer.indexOf(0),
        ),
      )
    const number = (buffer: Buffer) => {
      const text = field(buffer).trim()
      if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar numeric field.")
      const value = Number.parseInt(text, 8)
      if (!Number.isSafeInteger(value)) throw new Error("Oversized tar member.")
      return value
    }
    while (offset + 512 <= size) {
      // This is an implementation safety boundary against pathological metadata,
      // comfortably above the number of files in a packaged Electron app.
      if (++count > 500_000) throw new Error("Too many tar headers.")
      const header = Buffer.alloc(512)
      if ((await archive.read(header, 0, 512, offset)).bytesRead !== 512)
        throw new Error("Truncated tar header.")
      if (header.every((byte) => byte === 0)) {
        if (longName || longLink || Object.keys(extended).length)
          throw new Error("Unconsumed tar metadata.")
        if (members.get(key("Yakitori.app")) !== "5")
          throw new Error("Archive must contain one Yakitori.app.")
        const trailing = Buffer.alloc(64 * 1024)
        for (let rest = offset; rest < size; rest += trailing.length) {
          const { bytesRead } = await archive.read(
            trailing,
            0,
            Math.min(trailing.length, size - rest),
            rest,
          )
          if (trailing.subarray(0, bytesRead).some((byte) => byte !== 0))
            throw new Error("Unexpected data after tar end marker.")
        }
        for (const path of members.keys()) {
          let parent = posix.dirname(path)
          while (parent !== ".") {
            if (members.has(key(parent)) && members.get(key(parent)) !== "5")
              throw new Error(`Tar member traverses a non-directory: ${path}`)
            parent = posix.dirname(parent)
          }
        }
        for (const [path, target] of links) {
          const pending = [
            ...posix.dirname(path).split("/"),
            ...target.split("/"),
          ]
          const resolved: string[] = []
          let followed = 0
          while (pending.length) {
            const segment = pending.shift()
            if (!segment || segment === ".") continue
            if (segment === "..") {
              if (resolved.length <= 1)
                throw new Error(`Escaping tar symlink: ${path}`)
              resolved.pop()
              continue
            }
            resolved.push(segment)
            const link = links.get(key(resolved.join("/")))
            if (link !== undefined) {
              // Match the OS symlink traversal bound and reject cycles before
              // extraction. Resolve ".." after links, never lexically first.
              if (++followed > 32)
                throw new Error(`Cyclic tar symlink: ${path}`)
              resolved.pop()
              pending.unshift(...link.split("/"))
            }
          }
        }
        return
      }
      const checksum = number(header.subarray(148, 156))
      const computed = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      )
      if (checksum !== computed) throw new Error("Invalid tar header checksum.")
      const bytes = number(header.subarray(124, 136))
      if (offset + 512 + bytes > size) throw new Error("Truncated tar member.")
      const type = String.fromCharCode(header[156] || 48)
      if (["x", "L", "K"].includes(type)) {
        if (bytes > 1024 * 1024)
          throw new Error("Tar metadata exceeds the 1 MiB safety boundary.")
        const payload = Buffer.alloc(bytes)
        await archive.read(payload, 0, bytes, offset + 512)
        if (type === "x") {
          let cursor = 0
          while (cursor < payload.length) {
            const space = payload.indexOf(32, cursor)
            const length = Number(payload.subarray(cursor, space).toString())
            if (
              space < cursor ||
              !Number.isSafeInteger(length) ||
              length <= space - cursor + 2 ||
              cursor + length > payload.length ||
              payload[cursor + length - 1] !== 10
            )
              throw new Error("Invalid PAX record.")
            const record = payload.subarray(space + 1, cursor + length - 1)
            const equal = record.indexOf(61)
            if (equal < 1) throw new Error("Invalid PAX attribute.")
            const attribute = decode(record.subarray(0, equal))
            if (attribute.toLowerCase().includes("sparse"))
              throw new Error("Sparse tar members are unsupported.")
            // macOS may carry binary xattrs in PAX records. Only structural
            // attributes are text and affect where extraction writes files.
            if (["path", "linkpath", "size"].includes(attribute))
              extended[attribute] = decode(record.subarray(equal + 1))
            cursor += length
          }
        } else if (type === "L") longName = field(payload).replace(/\n$/, "")
        else longLink = field(payload).replace(/\n$/, "")
      } else {
        if (!["0", "2", "5"].includes(type))
          throw new Error(`Unsupported tar member type: ${type}`)
        if (extended.size !== undefined && extended.size !== String(bytes))
          throw new Error("Tar size overrides are unsupported.")
        const prefix = field(header.subarray(345, 500))
        const name =
          extended.path ??
          longName ??
          [prefix, field(header.subarray(0, 100))].filter(Boolean).join("/")
        if (
          isAbsolute(name) ||
          unsafeCharacters(name) ||
          name.split("/").includes("..")
        )
          throw new Error(`Unsafe tar member path: ${name}`)
        const path = posix.normalize(name).replace(/\/$/, "")
        if (path !== ".") {
          if (path !== "Yakitori.app" && !path.startsWith("Yakitori.app/"))
            throw new Error("Archive must contain only Yakitori.app.")
          if (members.has(key(path)))
            throw new Error(`Duplicate tar member: ${path}`)
          members.set(key(path), type)
          if (type === "2") {
            const link =
              extended.linkpath ?? longLink ?? field(header.subarray(157, 257))
            const destination = posix.normalize(
              posix.join(posix.dirname(path), link),
            )
            if (
              !link ||
              isAbsolute(link) ||
              unsafeCharacters(link) ||
              (destination !== "Yakitori.app" &&
                !destination.startsWith("Yakitori.app/"))
            )
              throw new Error(`Escaping tar symlink: ${path}`)
            links.set(key(path), link)
          }
        } else if (type !== "5") throw new Error("Invalid tar root.")
        extended = {}
        longName = undefined
        longLink = undefined
      }
      offset += 512 + Math.ceil(bytes / 512) * 512
    }
    throw new Error("Tar archive has no end marker.")
  } finally {
    await archive.close()
  }
}

export async function prepareDesktopUpdate({
  archivePath,
  stageDirectory,
  installedAppPath,
  expectedBuild,
}: {
  archivePath: string
  stageDirectory: string
  installedAppPath: string
  expectedBuild: DesktopBuildInfo
}): Promise<{ appPath: string }> {
  await validateArchive(archivePath)
  const installed = await realpath(installedAppPath)
  let stage: string
  try {
    stage = await realpath(stageDirectory)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
    stage = join(
      await realpath(dirname(resolve(stageDirectory))),
      basename(stageDirectory),
    )
  }
  if (stage === installed || stage.startsWith(`${installed}${sep}`))
    throw new Error("Update staging must be outside the installed app.")
  await mkdir(stage, { mode: 0o700, recursive: true })
  // Own a fresh child rather than extracting into a caller directory that may
  // already contain symlinks or files from a previous attempt.
  const work = join(stage, "prepared-update")
  await mkdir(work, { mode: 0o700 })
  try {
    const helper = join(installed, nativeHelper)
    const requirementOutput = await run("/usr/bin/codesign", [
      "-d",
      "-r-",
      helper,
    ])
    const requirement =
      `${requirementOutput.stdout}\n${requirementOutput.stderr}`.match(
        /^designated => (.+)$/m,
      )?.[1]
    const certificatePrefix = join(work, "installed-certificate-")
    await run("/usr/bin/codesign", [
      "-d",
      `--extract-certificates=${certificatePrefix}`,
      helper,
    ])
    let certificate: Buffer
    try {
      certificate = await readFile(`${certificatePrefix}0`)
    } catch (error) {
      throw new Error("Installed helper has no local signing certificate.", {
        cause: error,
      })
    }
    if (!requirement)
      throw new Error("Installed helper has no designated requirement.")
    const fingerprint = createHash("sha1")
      .update(certificate)
      .digest("hex")
      .toUpperCase()
    // Local self-signed identities are intentionally not globally trusted.
    // security's valid-only (-v) view hides them even though codesign can pin
    // their exact leaf certificate and preserve the existing privacy identity.
    const identities = (
      await run("/usr/bin/security", ["find-identity", "-p", "codesigning"])
    ).stdout
    const identity = identities.match(
      new RegExp(`^\\s*\\d+\\) ${fingerprint} "[^"]*"(.*)$`, "im"),
    )
    if (!identity)
      throw new Error(
        `Installed helper signing identity ${fingerprint} is unavailable; its existing certificate and private key are required.`,
      )
    const identityFailure = identity[1]?.trim()
    if (identityFailure && identityFailure !== "(CSSMERR_TP_NOT_TRUSTED)")
      throw new Error(
        `Installed helper signing identity ${fingerprint} is unusable: ${identityFailure}`,
      )
    await run("/usr/bin/codesign", ["--verify", "--strict", helper])
    await run("/usr/bin/tar", [
      "-xf",
      resolve(archivePath),
      "-C",
      work,
      "--no-same-owner",
    ])
    const appPath = join(work, "Yakitori.app")
    const info = await run("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      join(appPath, "Contents/Info.plist"),
    ])
    if (info.stdout.trim() !== "com.yakitori.app")
      throw new Error(
        "Prepared app must have bundle identifier com.yakitori.app.",
      )
    const executable = join(appPath, "Contents/MacOS/Yakitori")
    if (!(await lstat(executable)).isFile())
      throw new Error("Prepared app executable must be a regular file.")
    await access(executable, constants.X_OK)
    const metadata: unknown = JSON.parse(
      await readFile(
        join(appPath, "Contents/Resources/build-info.json"),
        "utf8",
      ),
    )
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Object.entries(expectedBuild).some(
        ([key, value]) =>
          !Object.hasOwn(metadata, key) || Reflect.get(metadata, key) !== value,
      )
    )
      throw new Error(
        "Prepared app build metadata does not match the expected release.",
      )
    const stagedHelper = join(appPath, nativeHelper)
    await run("/usr/bin/codesign", [
      "--force",
      "--sign",
      fingerprint,
      "--timestamp=none",
      "--identifier",
      "com.yakitori.computer",
      stagedHelper,
    ])
    await run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "-R",
      `=${requirement}`,
      stagedHelper,
    ])
    await signDesktopApplication(appPath)
    await run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "-R",
      `=${requirement}`,
      stagedHelper,
    ])
    return { appPath }
  } catch (error) {
    await removeUpdateDirectory(work)
    throw error
  }
}
