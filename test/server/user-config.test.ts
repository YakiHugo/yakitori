import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "smol-toml"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createUserConfigStore } from "../../src/server/user-config.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("user config", () => {
  it("omits the preference when the injected file is missing", async () => {
    await withConfigPath(async (configPath) => {
      const store = createUserConfigStore({ configPath })

      await expect(store.read()).resolves.toBeUndefined()
      await expect(store.readConfiguration()).resolves.toEqual({})
    })
  })

  it("reads the model context window alongside the model preference", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        [
          'provider = "codex"',
          'model = "gpt-5.6-sol"',
          "model_context_window = 600000",
          "",
        ].join("\n"),
      )
      const store = createUserConfigStore({ configPath })

      await expect(store.readConfiguration()).resolves.toEqual({
        preference: { provider: "codex", model: "gpt-5.6-sol" },
        modelContextWindowTokens: 600_000,
      })
    })
  })

  it("loads custom model instructions relative to the effective cwd", async () => {
    await withConfigPath(async (configPath) => {
      const cwd = dirname(configPath)
      await writeFile(
        join(cwd, "model-instructions.md"),
        "\nUse the custom harness instructions.\n",
      )
      await writeFile(
        configPath,
        [
          'model_instructions_file = "model-instructions.md"',
          'instructions = "legacy fallback"',
          "",
        ].join("\n"),
      )
      const store = createUserConfigStore({ configPath, cwd })

      await expect(store.readConfiguration()).resolves.toEqual({
        baseInstructions: "Use the custom harness instructions.",
      })
    })
  })

  it("loads the Codex-style shell environment policy", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        [
          "[shell_environment_policy]",
          'inherit = "core"',
          "ignore_default_excludes = false",
          'exclude = ["ACME_*", "CI_?"]',
          'include_only = ["PATH", "HOME", "MY_FLAG"]',
          "",
          "[shell_environment_policy.set]",
          'MY_FLAG = "1"',
          "",
        ].join("\n"),
      )
      const store = createUserConfigStore({ configPath })

      await expect(store.readConfiguration()).resolves.toEqual({
        shellEnvironmentPolicy: {
          inherit: "core",
          ignoreDefaultExcludes: false,
          exclude: ["ACME_*", "CI_?"],
          includeOnly: ["PATH", "HOME", "MY_FLAG"],
          set: { MY_FLAG: "1" },
        },
      })
    })
  })

  it.each([
    ['inherit = "nonee"', 'inherit must be "all", "core", or "none"'],
    ['exlcude = ["API_KEY"]', "Unknown shell_environment_policy field"],
  ])("fails closed for an invalid shell environment policy: %s", async (line, message) => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        ["[shell_environment_policy]", line, ""].join("\n"),
      )
      const store = createUserConfigStore({ configPath })

      await expect(store.readConfiguration()).rejects.toThrow(message)
    })
  })

  it("does not silently replace an unreadable custom instruction file", async () => {
    await withConfigPath(async (configPath) => {
      const cwd = dirname(configPath)
      await writeFile(
        configPath,
        'model_instructions_file = "missing-instructions.md"\n',
      )
      const store = createUserConfigStore({ configPath, cwd })

      await expect(store.readConfiguration()).rejects.toThrow(
        "Failed to read model instructions file",
      )
    })
  })

  it("round-trips a preference and preserves unknown TOML keys", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        [
          'provider = "faux"',
          'model = "scripted"',
          "model_context_window = 600000",
          'ui.theme = "dark"',
          "",
          "[[catalog]]",
          'name = "custom"',
          "models = [",
          '  "first",',
          '  "second",',
          "]",
          "",
        ].join("\n"),
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
      expect(parse(await readFile(configPath, "utf8"))).toEqual({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        speed: "priority",
        model_context_window: 600_000,
        ui: { theme: "dark" },
        catalog: [{ name: "custom", models: ["first", "second"] }],
      })
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

  it("rejects a non-positive model context window as malformed config", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, "model_context_window = 0\n")
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const store = createUserConfigStore({ configPath })

      await expect(store.readConfiguration()).resolves.toEqual({})
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
