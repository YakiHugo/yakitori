import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseDesktopBuildInfo } from "../src/desktop/update-release.ts"

const archiveName = "yakitori-macos-arm64.tar"
const archivePath = resolve("release", archiveName)
const build = parseDesktopBuildInfo(
  JSON.parse(await readFile(resolve("dist/build-info.json"), "utf8")),
)
const hash = createHash("sha256")
for await (const chunk of createReadStream(archivePath)) hash.update(chunk)
const manifest = {
  formatVersion: 1,
  build,
  archive: {
    name: archiveName,
    sha256: hash.digest("hex"),
    size: (await stat(archivePath)).size,
  },
}
const destination = resolve("release/update-manifest.json")
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Wrote ${destination}`)
