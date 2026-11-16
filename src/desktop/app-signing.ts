import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export async function signDesktopApplication(appPath: string): Promise<void> {
  const nativeHelper = join(
    appPath,
    "Contents/Resources/computer/Yakitori Computer.app",
  )
  const bundles: string[] = []
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      // This helper has a separate local certificate identity that must survive
      // both release packaging and staged application sealing.
      if (path === nativeHelper) continue
      await collect(path)
      if (/\.(app|framework|xpc)$/.test(entry.name)) bundles.push(path)
    }
  }
  const contents = await readdir(join(appPath, "Contents"), {
    withFileTypes: true,
  })
  if (
    contents.some((entry) => entry.name === "Frameworks" && entry.isDirectory())
  )
    await collect(join(appPath, "Contents/Frameworks"))
  try {
    for (const bundle of bundles)
      await exec("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        bundle,
      ])
    await exec("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--identifier",
      "com.yakitori.app",
      appPath,
    ])
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath])
  } catch (error) {
    throw new Error(
      `Application signing failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
