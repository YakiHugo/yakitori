import { spawn } from "node:child_process"

// This server-only boundary never hands an authorization URL (which can contain
// an ID-token hint) to the renderer, logs, a shell, or persisted app history.
export async function openChatGPTAuthorization(
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const target = new URL(url)
  if (
    target.origin !== "https://auth.openai.com" ||
    target.pathname !== "/api/accounts/authorize" ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error("Invalid ChatGPT authorization destination.")
  const [command, args] =
    process.platform === "darwin"
      ? (["/usr/bin/open", [url]] as const)
      : process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : (["xdg-open", [url]] as const)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: "ignore",
      ...(signal === undefined ? {} : { signal }),
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("The system browser could not be opened."))
    }, 10_000)
    timer.unref()
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("The system browser could not be opened."))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      code === 0
        ? resolve()
        : reject(new Error("The system browser could not be opened."))
    })
  })
}
