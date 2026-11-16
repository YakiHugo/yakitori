import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

export const capture = promisify(execFile)

export async function runBuild(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"}).`,
          ),
        )
    })
  })
}
