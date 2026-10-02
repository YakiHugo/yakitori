import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page } from "@playwright/test"

export async function createSmokeEnvironment(): Promise<
  Readonly<{
    root: string
    env: Readonly<Record<string, string>>
    cleanup(): Promise<void>
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-smoke-"))
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  try {
    await Promise.all([mkdir(home), mkdir(workspace)])
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const excluded = new Set([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "YAKITORI_MODEL",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
  ])
  // Startup discovers CLI logins as well as API keys. Isolate both sources
  // so a real app launch still cannot use the developer's model accounts.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !excluded.has(entry[0]),
    ),
  )
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    GROK_CREDENTIALS: join(home, "grok-auth.json"),
    YAKITORI_HOME: home,
    YAKITORI_STORE_DIR: join(root, "store"),
    YAKITORI_WORKSPACE: workspace,
    YAKITORI_PROVIDER: "faux",
    YAKITORI_FAUX_SCENARIO: "text",
    HOST: "127.0.0.1",
    PORT: "0",
  })
  return {
    root,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export async function runFauxTurn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New session", exact: true }).click()
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  await composer.fill("Check the CI smoke flow.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(
    page.getByRole("main").getByText("Hello from faux.", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toHaveCount(0)
}
