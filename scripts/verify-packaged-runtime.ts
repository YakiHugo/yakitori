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
await access(join(runtimeDirectory, "read-pdf-worker.js"))

await new Promise<void>((resolve, reject) => {
  const probe = [
    'Promise.all([import("fs-ext"), import("node-pty"), import("sharp"), import("@vscode/ripgrep")])',
    ".then(async ([, pty, sharp, { rgPath }]) => {",
    'const { execFileSync } = await import("node:child_process");',
    'const { mkdtemp, writeFile, rm } = await import("node:fs/promises");',
    'const { tmpdir } = await import("node:os");',
    'const { join } = await import("node:path");',
    'const fixture = await mkdtemp(join(tmpdir(), "yakitori-packaged-search-"));',
    'try { await writeFile(join(fixture, "needle.txt"), "packaged-search-ok\\n");',
    'const result = execFileSync(rgPath, ["--no-config", "--no-heading", "-n", "--", "packaged-search-ok", "needle.txt"], { cwd: fixture, env: { PATH: "" }, encoding: "utf8" });',
    'if (result !== "1:packaged-search-ok\\n") throw new Error("Packaged search failed: " + result);',
    "} finally { await rm(fixture, { recursive: true, force: true }); }",
    'await sharp.default({ create: { width: 16, height: 16, channels: 3, background: "red" } }).resize(8, 8).png().toBuffer();',
    'const { Worker } = await import("node:worker_threads");',
    'const { pathToFileURL } = await import("node:url");',
    'const pdfStream = "BT /F1 18 Tf 30 120 Td (Packaged PDF) Tj ET";',
    'const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>", "<< /Length " + pdfStream.length + " >>\\nstream\\n" + pdfStream + "\\nendstream"];',
    'let pdf = "%PDF-1.4\\n";',
    'const offsets = pdfObjects.map((body, index) => { const offset = Buffer.byteLength(pdf); pdf += (index + 1) + " 0 obj\\n" + body + "\\nendobj\\n"; return offset; });',
    "const xref = Buffer.byteLength(pdf);",
    'pdf += "xref\\n0 6\\n0000000000 65535 f \\n" + offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \\n").join("") + "trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n" + xref + "\\n%%EOF\\n";',
    'for (const format of ["text", "image"]) {',
    'const worker = new Worker(pathToFileURL(join(process.cwd(), "read-pdf-worker.js")), { workerData: { bytes: Uint8Array.from(Buffer.from(pdf)), format }, execArgv: [] });',
    "let timer;",
    "try {",
    'const result = await new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Packaged PDF worker timed out")), 30000); worker.once("message", resolve); worker.once("error", reject); worker.once("exit", (code) => reject(new Error("Packaged PDF worker exited: " + code))); });',
    'if (!result.ok) throw new Error("Packaged PDF failed: " + result.message);',
    'if (format === "text" && !result.text.includes("Packaged PDF")) throw new Error("Packaged PDF text missing");',
    'if (format === "image") { const image = result.images[0]; if (!image) throw new Error("Packaged PDF image missing"); const stats = await sharp.default(Buffer.from(image.bytes)).stats(); if (stats.channels[0].min >= 100) throw new Error("Packaged PDF rendered a blank page"); }',
    "} finally { clearTimeout(timer); await worker.terminate(); }",
    "}",
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
