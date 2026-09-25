import { tmpdir } from "node:os"
import { join } from "node:path"

// Server tests build real applications, and the application discovers local
// CLI logins and provider API keys from the environment. Point every
// credential source at a missing path so tests never touch the developer's
// real accounts — the startup catalog refresh would otherwise hit the network
// and write cache files into the test's temporary rootDir. Tests that need
// credentials set these variables explicitly themselves.
process.env.CODEX_HOME = join(tmpdir(), "yakitori-test-missing-codex-home")
process.env.GROK_CREDENTIALS = join(
  tmpdir(),
  "yakitori-test-missing-grok-auth.json",
)
delete process.env.XAI_API_KEY
delete process.env.KIMI_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.YAKITORI_PROVIDER
delete process.env.YAKITORI_MODEL
delete process.env.YAKITORI_FAUX_SCENARIO
