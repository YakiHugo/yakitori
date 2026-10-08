import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import sharp from "sharp"
import { expect, test } from "vitest"
import { parse } from "yaml"

test("app icons retain the approved master and all macOS representations", async () => {
  const source = await readFile("assets/app-icon/original-b.png")
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "1d77fa3e83a4def188d247d57e30bb1570380e5776a2dc9b8ca2ff5f47098571",
  )
  const config = parse(await readFile("electron-builder.yml", "utf8"))
  const icon = await readFile(config.mac.icon)
  expect(icon.toString("ascii", 0, 4)).toBe("icns")
  expect(icon.readUInt32BE(4)).toBe(icon.length)
  const expectedSizes: Record<string, number> = {
    icp4: 16,
    icp5: 32,
    icp6: 64,
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
    ic11: 32,
    ic12: 64,
    ic13: 256,
    ic14: 512,
  }
  const seen: string[] = []
  let offset = 8
  while (offset < icon.length) {
    const type = icon.toString("ascii", offset, offset + 4)
    const length = icon.readUInt32BE(offset + 4)
    expect(length).toBeGreaterThan(8)
    expect(offset + length).toBeLessThanOrEqual(icon.length)
    const png = icon.subarray(offset + 8, offset + length)
    const metadata = await sharp(png).metadata()
    expect(metadata.format).toBe("png")
    expect(metadata.width).toBe(expectedSizes[type])
    expect(metadata.height).toBe(expectedSizes[type])
    expect(metadata.hasAlpha).toBe(true)
    if (type === "ic10") expect(png.equals(source)).toBe(true)
    seen.push(type)
    offset += length
  }
  expect(offset).toBe(icon.length)
  expect(seen.sort()).toEqual(Object.keys(expectedSizes).sort())
})

test("browser favicon is linked and generated assets are reproducible", async () => {
  expect(await readFile("index.html", "utf8")).toContain(
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png" />',
  )
  const metadata = await sharp("public/favicon.png").metadata()
  expect([metadata.width, metadata.height, metadata.format]).toEqual([
    32,
    32,
    "png",
  ])
  execFileSync(process.execPath, ["scripts/generate-app-icons.ts", "--check"])
})
