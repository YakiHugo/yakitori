import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadLocalEnvFile } from "./env-file.ts"
import { runYakitoriServerProcess } from "./server-process.ts"

loadLocalEnvFile(".env")

const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 4141)
const rootDir = process.env.YAKITORI_STORE_DIR ?? ".yakitori"
const guiStaticDir = resolveGuiStaticDir()

await runYakitoriServerProcess({
  host,
  port,
  application: {
    rootDir,
    ...(guiStaticDir === undefined ? {} : { guiStaticDir }),
  },
  onListening(listeningUrl, application) {
    console.log(`Yakitori server listening on ${listeningUrl}`)
    // Machine-readable line for parent processes (Electron sidecar spawn).
    console.log(`yakitori-listening ${listeningUrl}`)
    console.log(
      `workspace=${application.workspace} mate=${application.activeMate.mateId} revision=${application.activeMate.mateRevisionId}`,
    )
  },
})

// The built GUI is served only when it exists, so `pnpm dev:server` with the
// vite dev server keeps working when dist/gui has not been built.
function resolveGuiStaticDir(): string | undefined {
  const configured = process.env.YAKITORI_GUI_DIR
  if (configured !== undefined) return configured
  const built = join(process.cwd(), "dist", "gui")
  return existsSync(built) ? built : undefined
}
