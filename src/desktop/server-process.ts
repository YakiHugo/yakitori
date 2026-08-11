import { spawn, type ChildProcess } from "node:child_process"

export type ServerProcess = {
  readonly child: ChildProcess
  readonly url: string
  stop(): Promise<void>
}

export type SpawnServerProcessInput = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly termToKillMs?: number
  readonly onStdout?: (line: string) => void
  readonly onStderr?: (line: string) => void
}

const LISTENING_PREFIX = "yakitori-listening "
const DEFAULT_LISTEN_TIMEOUT_MS = 15_000
const DEFAULT_TERM_TO_KILL_MS = 2_000

// Spawns the sidecar server and resolves once it prints its bound URL. The
// parent never guesses ports: the child owns the bind and reports the URL on
// one machine-readable stdout line, surrounded by arbitrary log noise.
export function spawnServerProcess(
  input: SpawnServerProcessInput,
): Promise<ServerProcess> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS
  const termToKillMs = input.termToKillMs ?? DEFAULT_TERM_TO_KILL_MS
  const onStdout = input.onStdout ?? ((line: string) => console.log(line))
  const onStderr = input.onStderr ?? ((line: string) => console.error(line))

  const child = spawn(input.command, [...input.args], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let exited:
    | { readonly code: number | null; readonly signal: string | null }
    | undefined
  child.once("exit", (code, signal) => {
    exited = { code, signal }
  })

  // stderr is forwarded line-wise so child errors reach the desktop log.
  let stderrTail: string[] = []
  readLines(child.stderr, (line) => {
    stderrTail = [...stderrTail.slice(-19), line]
    onStderr(line)
  })

  return new Promise<ServerProcess>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new Error(
          `Sidecar server did not report a listening URL within ${timeoutMs}ms.`,
        ),
      )
    }, timeoutMs)

    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(new Error(`Sidecar server failed to spawn: ${error.message}`))
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(
        new Error(
          `Sidecar server exited before listening (code ${exited?.code}, signal ${exited?.signal}).${stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : ""}`,
        ),
      )
    })

    readLines(child.stdout, (line) => {
      if (line.startsWith(LISTENING_PREFIX)) {
        clearTimeout(timeout)
        resolve({
          child,
          url: line.slice(LISTENING_PREFIX.length).trim(),
          stop: () => stopChild(child, () => exited, termToKillMs),
        })
        return
      }
      onStdout(line)
    })
  })
}

async function stopChild(
  child: ChildProcess,
  exited: () =>
    | { readonly code: number | null; readonly signal: string | null }
    | undefined,
  termToKillMs: number,
): Promise<void> {
  if (exited() !== undefined) return
  child.kill("SIGTERM")
  if (await waitForExit(child, exited, termToKillMs)) return
  child.kill("SIGKILL")
  await waitForExit(child, exited, termToKillMs)
}

async function waitForExit(
  child: ChildProcess,
  exited: () => unknown,
  timeoutMs: number,
): Promise<boolean> {
  if (exited() !== undefined) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    new Promise<"exit">((resolve) => child.once("exit", () => resolve("exit"))),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  return outcome === "exit"
}

function readLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (stream === null) return
  let buffer = ""
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  })
}
