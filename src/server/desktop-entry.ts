import { loadLocalEnvFile, resolveYakitoriHome } from "./env-file.ts"
import { runYakitoriServerProcess } from "./server-process.ts"

// Sidecar entry for the Electron desktop shell. Runs in a plain Node child
// process (ELECTRON_RUN_AS_NODE) in both dev and prod. The parent owns cwd
// (repo checkout in dev, the user-level home when packaged), so this local
// .env load finds the right file in both forms.
loadLocalEnvFile(".env")

const host = "127.0.0.1"
// PORT=0 binds an ephemeral port: the parent reads the bound URL from stdout
// and never guesses, which kills the port-collision class of bugs.
const port = Number(process.env.PORT ?? 0)
const rootDir = process.env.YAKITORI_STORE_DIR || resolveYakitoriHome()
const guiStaticDir = process.env.YAKITORI_GUI_DIR

await runYakitoriServerProcess({
  host,
  port,
  application: {
    rootDir,
    ...(guiStaticDir === undefined ? {} : { guiStaticDir }),
  },
  onListening(url) {
    // The one machine-readable line the parent parses; keep it exactly this.
    console.log(`yakitori-listening ${url}`)
  },
})
