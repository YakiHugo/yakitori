import { existsSync } from "node:fs"
import { join } from "node:path"
import { createYakitoriApplication } from "./application.ts"
import { loadLocalEnvFile } from "./env-file.ts"

loadLocalEnvFile(".env")

const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 4141)
const rootDir = process.env.YAKITORI_STORE_DIR ?? ".yakitori"
const guiStaticDir = resolveGuiStaticDir()

const application = await createYakitoriApplication({
  rootDir,
  ...(guiStaticDir === undefined ? {} : { guiStaticDir }),
})
const server = application.createHttpServer()
let shuttingDown = false

server.listen(port, host, () => {
  console.log(`Yakitori server listening on http://${host}:${port}`)
  console.log(
    `workspace=${application.workspace} mate=${application.activeMate.mateId} revision=${application.activeMate.mateRevisionId}`,
  )
})

// The built GUI is served only when it exists, so `pnpm dev:server` with the
// vite dev server keeps working when dist/gui has not been built.
function resolveGuiStaticDir(): string | undefined {
  const configured = process.env.YAKITORI_GUI_DIR
  if (configured !== undefined) return configured
  const built = join(process.cwd(), "dist", "gui")
  return existsSync(built) ? built : undefined
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    server.close((serverError) => {
      void application.close().then(
        () => {
          if (serverError)
            console.error("HTTP server close failed", serverError)
          process.exit(serverError ? 1 : 0)
        },
        (error: unknown) => {
          console.error("Yakitori shutdown failed", error)
          process.exit(1)
        },
      )
    })
    server.closeAllConnections()
    setTimeout(() => {
      process.exit(1)
    }, 10_000).unref()
  })
}
