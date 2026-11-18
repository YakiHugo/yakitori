import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const source = "https://registry.npmjs.org/@openai%2Fcodex/latest"

export class CodexVersionLookupError extends Error {}

export async function syncCodexVersion(workspace: string): Promise<void> {
  const signal = AbortSignal.timeout(10_000)
  let release: unknown
  try {
    const response = await fetch(source, { redirect: "error", signal })
    if (!response.ok)
      throw new CodexVersionLookupError(
        `Codex release lookup failed (HTTP ${response.status}).`,
      )
    release = await response.json()
  } catch (cause) {
    if (
      cause instanceof TypeError ||
      (signal.aborted && cause instanceof DOMException)
    )
      throw new CodexVersionLookupError(
        "Could not reach the Codex release registry.",
        { cause },
      )
    if (cause instanceof SyntaxError)
      throw new CodexVersionLookupError(
        "The Codex release registry returned invalid JSON.",
        { cause },
      )
    throw cause
  }
  if (
    typeof release !== "object" ||
    release === null ||
    !("name" in release) ||
    release.name !== "@openai/codex" ||
    !("version" in release) ||
    typeof release.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(release.version)
  )
    throw new CodexVersionLookupError(
      "The Codex release registry did not return a stable version.",
    )

  const target = join(workspace, "src/runtime/codex-client-version.json")
  const contents = `${JSON.stringify({ clientVersion: release.version }, null, 2)}\n`
  if ((await readFile(target, "utf8")) === contents) {
    console.log(`Codex catalog client version is already ${release.version}.`)
    return
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  console.log(`Updated Codex catalog client version to ${release.version}.`)
}

if (import.meta.main)
  await syncCodexVersion(fileURLToPath(new URL("../", import.meta.url)))
