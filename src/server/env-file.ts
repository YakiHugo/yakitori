import { existsSync } from "node:fs"

// Loads a local, gitignored .env (provider keys, YAKITORI_* settings) into
// process.env. process.loadEnvFile never overrides variables that are already
// set, so the real environment always wins over the file.
export function loadLocalEnvFile(path: string): void {
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}
