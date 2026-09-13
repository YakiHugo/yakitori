import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Loads a local, gitignored .env (provider keys, YAKITORI_* settings) into
// process.env. process.loadEnvFile never overrides variables that are already
// set, so the real environment always wins over the file.
export function loadLocalEnvFile(path: string): void {
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}

// Single user-level home for config and state, shared by every app form
// (codex's CODEX_HOME pattern); YAKITORI_HOME overrides it. An empty value
// counts as unset so a blanked-out .env line cannot hijack the path.
export function resolveYakitoriHome(): string {
  return process.env.YAKITORI_HOME || join(homedir(), ".yakitori")
}
