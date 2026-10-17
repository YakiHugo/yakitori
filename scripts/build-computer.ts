import { execFile } from "node:child_process"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

if (process.platform !== "darwin") {
  // Linux CI still compiles the Electron/renderer bundles. The native backend
  // is built and verified by the separate macOS job, and is unavailable here.
  console.log("Skipping the macOS computer helper on this platform.")
  process.exit(0)
}
const run = promisify(execFile)
const scratch = resolve("build/computer")
const args = [
  "--package-path",
  "native/computer",
  "--scratch-path",
  scratch,
  "-c",
  "release",
]
await run("swift", ["build", ...args], { maxBuffer: 4 * 1024 * 1024 })
const { stdout } = await run("swift", ["build", ...args, "--show-bin-path"])
const contents = resolve("dist/native/Yakitori Computer.app/Contents")
await mkdir(join(contents, "MacOS"), { recursive: true })
await copyFile(
  join(stdout.trim(), "yakitori-computer"),
  join(contents, "MacOS/yakitori-computer"),
)
await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.yakitori.computer</string>
<key>CFBundleName</key><string>Yakitori Computer</string>
<key>CFBundleExecutable</key><string>yakitori-computer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Yakitori observes app windows to carry out your tasks.</string>
<key>NSAccessibilityUsageDescription</key><string>Yakitori reads and operates app controls for your tasks.</string>
</dict></plist>
`,
)
await run("/usr/bin/codesign", [
  "--force",
  "--sign",
  process.env.YAKITORI_CODESIGN_IDENTITY ?? "-",
  "--identifier",
  "com.yakitori.computer",
  resolve(contents, ".."),
])
console.log("Built dist/native/Yakitori Computer.app")
