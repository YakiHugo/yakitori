import { access } from "node:fs/promises"
import { arch, platform } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

if (platform() !== "darwin") {
  throw new Error("Packaged runtime verification currently supports macOS.")
}

const applicationDirectory = resolve(
  "release",
  `mac${arch() === "arm64" ? "-arm64" : ""}`,
  "Yakitori.app",
)
const executable = join(applicationDirectory, "Contents", "MacOS", "Yakitori")
const runtimeDirectory = join(
  applicationDirectory,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "dist",
  "desktop",
)
await access(executable)
await access(runtimeDirectory)

await new Promise<void>((resolve, reject) => {
  const child = spawn(
    executable,
    [
      "--input-type=module",
      "--eval",
      'import("fs-ext").then(() => process.stdout.write("native-runtime-ok\\n"))',
    ],
    {
      cwd: runtimeDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  child.once("error", reject)
  child.once("exit", (code) => {
    if (code === 0 && stdout === "native-runtime-ok\n") resolve()
    else reject(new Error(`Packaged runtime probe failed (${code}): ${stderr}`))
  })
})
