import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

// Application/sidecar integration tests discover accounts and create credential
// locks even without signing in. Isolate the actual home too, so a developer's
// ChatGPT account is never read or written and child processes inherit the same
// boundary. A unique directory per test file also prevents cross-worker state.
const home = mkdtempSync(join(tmpdir(), "yakitori-test-home-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_CONFIG_HOME = join(home, ".config")
process.env.CODEX_HOME = join(home, ".codex")
process.env.GROK_CREDENTIALS = join(home, ".grok", "auth.json")
afterAll(() => rmSync(home, { recursive: true, force: true }))

delete process.env.XAI_API_KEY
delete process.env.KIMI_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.YAKITORI_PROVIDER
delete process.env.YAKITORI_MODEL
delete process.env.YAKITORI_FAUX_SCENARIO
