import { createYakitoriApplication } from "./application.ts"

const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 4141)
const rootDir = process.env.YAKITORI_STORE_DIR ?? ".yakitori"

const application = await createYakitoriApplication({ rootDir })
const server = application.createHttpServer()
let shuttingDown = false

server.listen(port, host, () => {
  console.log(`Yakitori server listening on http://${host}:${port}`)
  console.log(
    `workspace=${application.workspace} mate=${application.activeMate.mateId} revision=${application.activeMate.mateRevisionId}`,
  )
})

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
