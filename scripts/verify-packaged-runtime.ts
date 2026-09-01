import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { arch, platform } from "node:os"
import { join, resolve } from "node:path"

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
  const probe = [
    'Promise.all([import("fs-ext"), import("node-pty")])',
    ".then(([, pty]) => {",
    "const spawnPty = pty.spawn ?? pty.default?.spawn;",
    'if (spawnPty === undefined) throw new Error("node-pty spawn export missing");',
    'const terminal = spawnPty("/bin/sh", ["-c", "test -t 0 && printf native-runtime-ok"], {',
    'name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(),',
    "env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),",
    "});",
    'let output = "";',
    "terminal.onData((chunk) => { output += chunk; });",
    "terminal.onExit(({ exitCode }) => {",
    'if (exitCode === 0 && output.includes("native-runtime-ok")) process.stdout.write("native-runtime-ok\\n");',
    "else { process.stderr.write(output); process.exit(1); }",
    "});",
    "})",
    ".catch((error) => { process.stderr.write(String(error)); process.exit(1); });",
  ].join(" ")
  const child = spawn(executable, ["--input-type=module", "--eval", probe], {
    cwd: runtimeDirectory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
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
