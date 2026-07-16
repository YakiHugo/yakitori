import { parentPort, workerData } from "node:worker_threads"
import {
  createMateRevisionId,
  createSqliteMateStore,
  isYakitoriError,
  MateEventType,
} from "../../src/index.ts"

type WorkerInput = {
  readonly databasePath: string
  readonly mateId: string
  readonly startGate: SharedArrayBuffer
}

const input = workerData as WorkerInput
if (!parentPort) throw new Error("Expected a parent worker port.")
const port = parentPort

const store = createSqliteMateStore({ databasePath: input.databasePath })
port.postMessage({ type: "ready" })
Atomics.wait(new Int32Array(input.startGate), 0, 0)
try {
  await store.appendEvent(
    input.mateId,
    {
      type: MateEventType.ProfileRevised,
      data: {
        profile: {
          instructions: "Concurrent revision",
          name: "Momo",
          role: "Reviewer",
        },
        revision: 2,
        revisionId: createMateRevisionId(),
      },
    },
    { expectedSeq: 1 },
  )
  port.postMessage({ ok: true })
} catch (error) {
  port.postMessage({
    ok: false,
    ...(isYakitoriError(error) ? { code: error.code } : {}),
  })
} finally {
  store.close()
}
