import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createUserConfigStore } from "../../src/index.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("user config", () => {
  it("omits the preference when the injected file is missing", async () => {
    await withConfigPath(async (configPath) => {
      const store = createUserConfigStore({ configPath })

      await expect(store.read()).resolves.toBeUndefined()
    })
  })

  it("round-trips a preference and preserves unknown TOML keys", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        'theme = "dark"\nprovider = "faux"\nmodel = "scripted"\n',
      )
      const store = createUserConfigStore({ configPath })
      const preference = {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        speed: "priority",
      }

      await expect(store.write(preference)).resolves.toEqual(preference)
      await expect(store.read()).resolves.toEqual(preference)
      expect(await readFile(configPath, "utf8")).toBe(
        'provider = "codex"\nmodel = "gpt-5.6-sol"\neffort = "low"\nspeed = "priority"\n\ntheme = "dark"\n',
      )
    })
  })

  it("warns and treats malformed TOML as an empty preference", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, 'provider = "unterminated\nmodel = "x"\n')
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const store = createUserConfigStore({ configPath })

      await expect(store.read()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring malformed user config"),
        expect.any(Error),
      )
    })
  })
})

async function withConfigPath(
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "yakitori-user-config-"))
  try {
    await run(join(directory, "config.toml"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
