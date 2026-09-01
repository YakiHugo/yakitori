import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  isServerControlRequest,
  type ServerControlRequest,
  type ServerControlResponse,
} from "../desktop/server-control.ts"
import { createYakitoriApplication } from "./application.ts"
import { loadLocalEnvFile } from "./env-file.ts"
import { shutdownHttpApplication } from "./shutdown.ts"

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

process.on("message", (message: unknown) => {
  if (!isServerControlRequest(message) || process.send === undefined) return
  void handleControlRequest(message).then((response) =>
    process.send?.(response),
  )
})

server.listen(port, host, () => {
  const address = server.address()
  const listeningUrl =
    address === null || typeof address === "string"
      ? `http://${host}:${port}`
      : `http://${host}:${address.port}`
  console.log(`Yakitori server listening on ${listeningUrl}`)
  // Machine-readable line for parent processes (Electron sidecar spawn).
  console.log(`yakitori-listening ${listeningUrl}`)
  console.log(
    `workspace=${application.workspace} mate=${application.activeMate.mateId} revision=${application.activeMate.mateRevisionId}`,
  )
  void application.probeUserShellEnv().catch((error: unknown) => {
    console.warn("exec_command shell-env probe failed", error)
  })
})

async function handleControlRequest(
  request: ServerControlRequest,
): Promise<ServerControlResponse> {
  try {
    if (request.type === "import_image_paths") {
      const thread = await application.threadStore.readThread(request.sessionId)
      if (thread === undefined) {
        throw new Error(`Session ${request.sessionId} was not found.`)
      }
      const attachments = await application.rolloutAssets.importImagePaths(
        thread.metadata.rolloutId,
        request.ownerId,
        request.paths,
      )
      return { requestId: request.requestId, ok: true, attachments }
    }
    await application.rolloutAssets.discardDraftImageAttachments(
      request.attachments,
    )
    return { requestId: request.requestId, ok: true }
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error ? error.message : "Attachment import failed.",
    }
  }
}

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
    void shutdownHttpApplication({
      server,
      closeApplication: () => application.close(),
    }).then(
      (clean) => {
        process.exit(clean ? 0 : 1)
      },
      (error: unknown) => {
        console.error("Yakitori shutdown failed", error)
        process.exit(1)
      },
    )
    // Backstop only: a wedged event loop must never outlive this timer.
    setTimeout(() => {
      process.exit(1)
    }, 5_000).unref()
  })
}
