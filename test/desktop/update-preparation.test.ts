import { execFile } from "node:child_process"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { prepareDesktopUpdate } from "../../src/desktop/update-preparation.ts"
import type { DesktopBuildInfo } from "../../src/protocol/desktop-update.ts"

const exec = promisify(execFile)
const roots: string[] = []
const build: DesktopBuildInfo = {
  repository: "owner/yakitori",
  version: "0.0.0",
  commit: "a".repeat(40),
  dirty: false,
  channel: "main",
  buildNumber: 12,
  buildAttempt: 1,
  builtAt: "2026-11-15T00:00:00.000Z",
  platform: "darwin",
  arch: "arm64",
}
const darwin = it.skipIf(process.platform !== "darwin")

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "yakitori-update-preparation-")),
  )
  roots.push(root)
  const stageDirectory = join(root, "stage")
  await mkdir(stageDirectory)
  const installedAppPath = join(root, "installed.app")
  const helper = join(
    installedAppPath,
    "Contents/Resources/computer/Yakitori Computer.app",
  )
  await bundle(helper, "com.yakitori.computer", "yakitori-computer")
  await exec("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.yakitori.computer",
    helper,
  ])
  return {
    root,
    stageDirectory,
    installedAppPath,
    expectedBuild: build,
    archivePath: join(root, "update.tar"),
    helper,
  }
}

async function bundle(path: string, identifier: string, executable: string) {
  await mkdir(join(path, "Contents/MacOS"), { recursive: true })
  await copyFile("/usr/bin/true", join(path, "Contents/MacOS", executable))
  await writeFile(
    join(path, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
}

// Construct headers independently so malicious paths are retained (tar creation
// tools commonly sanitize them before an updater ever sees the archive).
async function archive(
  path: string,
  members: { name: string; type?: string; link?: string; data?: Buffer }[],
) {
  const chunks = members.flatMap((member) => {
    const header = Buffer.alloc(512)
    header.write(member.name, 0, 100)
    header.write("0000755\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(
      `${(member.data?.length ?? 0).toString(8).padStart(11, "0")}\0`,
      124,
    )
    header.write("00000000000\0", 136)
    header.fill(32, 148, 156)
    header.write(member.type ?? "5", 156)
    if (member.link) header.write(member.link, 157, 100)
    header.write("ustar\0", 257)
    header.write("00", 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
    const payload = Buffer.alloc(
      Math.ceil((member.data?.length ?? 0) / 512) * 512,
    )
    member.data?.copy(payload)
    return [header, payload]
  })
  await writeFile(path, Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

darwin.each([
  { name: "Yakitori.app/../../escape", error: "Unsafe tar member" },
  { name: "/tmp/Yakitori.app", error: "Unsafe tar member" },
  { name: "Other.app", error: "only Yakitori.app" },
  {
    name: "Yakitori.app/link",
    type: "2",
    link: "../../escape",
    error: "Escaping tar symlink",
  },
  {
    name: "Yakitori.app/link",
    type: "1",
    link: "Yakitori.app/file",
    error: "Unsupported tar member",
  },
])(
  "rejects unsafe archive member $name before touching the installed app",
  async (member) => {
    const app = await fixture()
    const original = await readFile(
      join(app.helper, "Contents/MacOS/yakitori-computer"),
    )
    await archive(app.archivePath, [{ name: "Yakitori.app" }, member])
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(member.error)
    expect(
      await readFile(join(app.helper, "Contents/MacOS/yakitori-computer")),
    ).toEqual(original)
  },
)

darwin(
  "rejects members beneath a symlink even when the symlink appears later",
  async () => {
    const app = await fixture()
    await archive(app.archivePath, [
      { name: "Yakitori.app" },
      { name: "Yakitori.app/link/file", type: "0" },
      { name: "Yakitori.app/link", type: "2", link: "Contents" },
    ])
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(
      "traverses a non-directory",
    )
  },
)

darwin(
  "rejects symlink escapes through another symlink before resolving parent segments",
  async () => {
    const app = await fixture()
    await archive(app.archivePath, [
      { name: "Yakitori.app" },
      { name: "Yakitori.app/current", type: "2", link: "." },
      { name: "Yakitori.app/escape", type: "2", link: "current/../outside" },
    ])
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(
      "Escaping tar symlink",
    )
  },
)

darwin(
  "validates PAX paths instead of the harmless fallback header name",
  async () => {
    const app = await fixture()
    const value = "path=Yakitori.app/../escape\n"
    const data = Buffer.from(`${Buffer.byteLength(value) + 3} ${value}`)
    await archive(app.archivePath, [
      { name: "Yakitori.app" },
      { name: "PaxHeader", type: "x", data },
      { name: "Yakitori.app/safe", type: "0" },
    ])
    await expect(prepareDesktopUpdate(app)).rejects.toThrow("Unsafe tar member")
  },
)

darwin(
  "rejects member traversal through a differently cased symlink on macOS filesystems",
  async () => {
    const app = await fixture()
    await archive(app.archivePath, [
      { name: "Yakitori.app" },
      { name: "Yakitori.app/Link", type: "2", link: "Contents" },
      { name: "Yakitori.app/link/file", type: "0" },
    ])
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(
      "traverses a non-directory",
    )
  },
)

darwin(
  "fails with an ad-hoc installed helper before extracting or changing it",
  async () => {
    const app = await fixture()
    await archive(app.archivePath, [{ name: "Yakitori.app" }])
    const original = await readFile(
      join(app.helper, "Contents/MacOS/yakitori-computer"),
    )
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(
      "no local signing certificate",
    )
    expect(
      await readFile(join(app.helper, "Contents/MacOS/yakitori-computer")),
    ).toEqual(original)
    await expect(
      readFile(
        join(
          app.stageDirectory,
          "prepared-update/Yakitori.app/Contents/Info.plist",
        ),
      ),
    ).rejects.toThrow()
  },
)

darwin(
  "preserves an existing staging directory instead of extracting into it",
  async () => {
    const app = await fixture()
    await archive(app.archivePath, [{ name: "Yakitori.app" }])
    await mkdir(join(app.stageDirectory, "prepared-update"))
    await writeFile(
      join(app.stageDirectory, "prepared-update/keep"),
      "untouched",
    )
    await expect(prepareDesktopUpdate(app)).rejects.toThrow()
    expect(
      await readFile(join(app.stageDirectory, "prepared-update/keep"), "utf8"),
    ).toBe("untouched")
  },
)

darwin(
  "rejects an installed certificate whose private signing identity is unavailable",
  async () => {
    const app = await fixture()
    // Apple's system binary has a real public signing certificate, but its
    // private key is never present in this developer's keychain.
    await copyFile(
      "/usr/bin/true",
      join(app.helper, "Contents/MacOS/yakitori-computer"),
    )
    await archive(app.archivePath, [{ name: "Yakitori.app" }])
    const original = await readFile(
      join(app.helper, "Contents/MacOS/yakitori-computer"),
    )
    await expect(prepareDesktopUpdate(app)).rejects.toThrow(
      "existing certificate and private key are required",
    )
    expect(
      await readFile(join(app.helper, "Contents/MacOS/yakitori-computer")),
    ).toEqual(original)
  },
)

darwin(
  "prepares and seals copied system binaries using an existing exact local identity",
  async (context) => {
    const identities = await exec("/usr/bin/security", [
      "find-identity",
      "-p",
      "codesigning",
    ])
    const fingerprint = identities.stdout.match(/\b([A-F0-9]{40})\b/i)?.[1]
    if (!fingerprint) {
      context.skip()
      return
    }
    const app = await fixture()
    await exec("/usr/bin/codesign", [
      "--force",
      "--sign",
      fingerprint,
      "--identifier",
      "com.yakitori.computer",
      app.helper,
    ])
    const oldRequirementOutput = await exec("/usr/bin/codesign", [
      "-d",
      "-r-",
      app.helper,
    ])
    const oldRequirement =
      `${oldRequirementOutput.stdout}\n${oldRequirementOutput.stderr}`.match(
        /^designated => (.+)$/m,
      )?.[1]
    expect(oldRequirement).toBeTypeOf("string")
    const source = join(app.root, "source/Yakitori.app")
    await bundle(source, "com.yakitori.app", "Yakitori")
    await mkdir(join(source, "Contents/Resources"), { recursive: true })
    await writeFile(
      join(source, "Contents/Resources/build-info.json"),
      JSON.stringify(build),
    )
    const stagedHelper = join(
      source,
      "Contents/Resources/computer/Yakitori Computer.app",
    )
    await bundle(stagedHelper, "com.yakitori.computer", "yakitori-computer")
    await bundle(
      join(source, "Contents/Frameworks/Test Helper.app"),
      "com.yakitori.fixture",
      "fixture",
    )
    await symlink("Frameworks", join(source, "Contents/LinkedFrameworks"))
    await exec(
      "/usr/bin/tar",
      ["-cf", app.archivePath, "-C", join(app.root, "source"), "Yakitori.app"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    )
    const { appPath } = await prepareDesktopUpdate(app)
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])
    await exec("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "-R",
      `=${oldRequirement ?? ""}`,
      join(appPath, "Contents/Resources/computer/Yakitori Computer.app"),
    ])
    expect(
      await readFile(
        join(appPath, "Contents/Resources/build-info.json"),
        "utf8",
      ),
    ).toBe(JSON.stringify(build))
  },
  30_000,
)
