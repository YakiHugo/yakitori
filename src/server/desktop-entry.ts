import { createYakitoriApplication } from "./application.ts"
import { loadLocalEnvFile } from "./env-file.ts"
import { shutdownHttpApplication } from "./shutdown.ts"

// Sidecar entry for the Electron desktop shell. Runs in a plain Node child
// process (ELECTRON_RUN_AS_NODE) in both dev and prod. Dev spawns the repo
// checkout with cwd at the repo root, so a local .env still loads; packaged
// installs have no checkout .env and configure keys via the environment.
loadLocalEnvFile(".env")

const host = "127.0.0.1"
// PORT=0 binds an ephemeral port: the parent reads the bound URL from stdout
// and never guesses, which kills the port-collision class of bugs.
const port = Number(process.env.PORT ?? 0)
const rootDir = process.env.YAKITORI_STORE_DIR ?? ".yakitori"
const guiStaticDir = process.env.YAKITORI_GUI_DIR

const application = await createYakitoriApplication({
  rootDir,
  ...(guiStaticDir === undefined ? {} : { guiStaticDir }),
})
const server = application.createHttpServer()
let shuttingDown = false

server.listen(port, host, () => {
  const address = server.address()
  if (address === null || typeof address === "string") {
    console.error("yakitori: sidecar server did not bind a TCP address")
    process.exit(1)
  }
  // The one machine-readable line the parent parses; keep it exactly this.
  console.log(`yakitori-listening http://${host}:${address.port}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    void shutdownHttpApplication({
      server,
      closeApplication: () => application.close(),
    }).then(
      (clean) => {
        process.exit(clean ? 0 : 1)
      },
      (error: unknown) => {
        console.error("yakitori: sidecar shutdown failed", error)
        process.exit(1)
      },
    )
    setTimeout(() => {
      process.exit(1)
    }, 5_000).unref()
  })
}
