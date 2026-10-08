import { readFile, writeFile } from "node:fs/promises"
import sharp from "sharp"

// The approved original-B crop is the source of truth. Resize only: preserve
// its colors, transparency, framing and artwork, including the 1024px bytes.
const source = await readFile("assets/app-icon/original-b.png")
const metadata = await sharp(source).metadata()
if (metadata.width !== 1024 || metadata.height !== 1024) {
  throw new Error("The app icon master must be 1024 × 1024 pixels.")
}

const representations = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
] as const

const pngs = new Map<number, Buffer>([[1024, source]])
for (const [, size] of representations) {
  if (!pngs.has(size)) {
    pngs.set(
      size,
      await sharp(source)
        .resize(size, size, { kernel: "lanczos3" })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer(),
    )
  }
}

// Modern ICNS entries carry PNG payloads; lengths include their 8-byte header.
const entries = representations.map(([type, size]) => {
  const png = pngs.get(size)
  if (png === undefined) throw new Error(`Missing ${size}px icon`)
  const header = Buffer.alloc(8)
  header.write(type, 0, "ascii")
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
})
const header = Buffer.alloc(8)
header.write("icns", 0, "ascii")
header.writeUInt32BE(
  8 + entries.reduce((sum, entry) => sum + entry.length, 0),
  4,
)
const favicon = pngs.get(32)
if (favicon === undefined) throw new Error("Missing favicon")
const outputs = [
  ["assets/app-icon/icon.icns", Buffer.concat([header, ...entries])],
  ["public/favicon.png", favicon],
] as const

for (const [path, bytes] of outputs) {
  if (process.argv.includes("--check")) {
    if (!(await readFile(path)).equals(bytes)) {
      throw new Error(`${path} is stale; run pnpm icons:generate.`)
    }
  } else {
    await writeFile(path, bytes)
  }
}
