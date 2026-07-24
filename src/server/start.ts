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
    server.close(() => {
      void application.close().finally(() => {
        process.exit(0)
      })
    })
    server.closeAllConnections()
    setTimeout(() => {
      process.exit(1)
    }, 1_000).unref()
  })
}
