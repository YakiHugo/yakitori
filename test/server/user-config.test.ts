import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { flock } from "fs-ext"
import { parse } from "smol-toml"
import { describe, expect, it } from "vitest"
import type { OperationalFailure } from "../../src/server/operational-errors.ts"
import { createUserConfigStore } from "../../src/server/user-config.ts"

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

  it("reads the auto-compaction token limit and scope", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        [
          "model_auto_compact_token_limit = 120000",
          'model_auto_compact_token_limit_scope = "body_after_prefix"',
          "",
        ].join("\n"),
      )

      await expect(
        createUserConfigStore({ configPath }).readConfiguration(),
      ).resolves.toEqual({
        modelAutoCompactTokenLimit: 120_000,
        modelAutoCompactTokenLimitScope: "body_after_prefix",
      })
    })
  })

  it.each([
    "model_auto_compact_token_limit = 0",
    'model_auto_compact_token_limit_scope = "prefix"',
  ])("rejects invalid auto-compaction configuration: %s", async (line) => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, `${line}\n`)
      await expect(
        createUserConfigStore({ configPath }).readConfiguration(),
      ).rejects.toThrow("model_auto_compact_token_limit")
    })
  })

  it("loads an explicitly enabled shared rollout budget", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        `[features.rollout_budget]\nenabled = true\nlimit_tokens = 1000\nreminder_at_remaining_tokens = [500, 100]\nprefill_token_weight = 0.5\n`,
      )
      expect(
        (await createUserConfigStore({ configPath }).readConfiguration())
          .rolloutBudget,
      ).toEqual({
        limitTokens: 1000,
        reminderAtRemainingTokens: [500, 100],
        samplingTokenWeight: 1,
        prefillTokenWeight: 0.5,
      })
    })
  })

  it("loads MCP servers and Codex-style command hooks", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        [
          "[mcp_servers.local]",
          'command = "node"',
          'args = ["server.mjs"]',
          'cwd = "tools"',
          "startup_timeout_ms = 2500",
          "",
          "[mcp_servers.local.env]",
          'MCP_MODE = "test"',
          "",
          "[[hooks.PreToolUse]]",
          'matcher = "exec_.*"',
          "",
          "[[hooks.PreToolUse.hooks]]",
          'type = "command"',
          'command = "./check-tool.sh"',
          "timeout_ms = 1200",
          "async = false",
          'trusted_hash = "sha256"',
          "",
        ].join("\n"),
      )

      await expect(
        createUserConfigStore({ configPath }).readConfiguration(),
      ).resolves.toMatchObject({
        mcpServers: {
          local: {
            command: "node",
            args: ["server.mjs"],
            cwd: "tools",
            env: { MCP_MODE: "test" },
            startupTimeoutMs: 2500,
          },
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "exec_.*",
              hooks: [
                {
                  type: "command",
                  command: "./check-tool.sh",
                  timeoutMs: 1200,
                  async: false,
                  trustedHash: "sha256",
                },
              ],
            },
          ],
        },
      })
    })
  })

  it.each([
    "limit_tokens = 0\nreminder_at_remaining_tokens = []",
    "limit_tokens = 10\nreminder_at_remaining_tokens = [10]",
    "limit_tokens = 10",
    "limit_tokens = 10\nreminder_at_remaining_tokens = []\nsampling_token_weight = -1",
  ])("rejects an invalid enabled budget instead of silently disabling it: %s", async (settings) => {
    await withConfigPath(async (configPath) => {
      await writeFile(
        configPath,
        `[features.rollout_budget]\nenabled = true\n${settings}\n`,
      )
      await expect(
        createUserConfigStore({ configPath }).readConfiguration(),
      ).rejects.toThrow()
    })
  })

  it("resolves model_instructions_file relative to the config file directory", async () => {
    await withConfigPath(async (configPath) => {
      const configDirectory = dirname(configPath)
      await writeFile(
        join(configDirectory, "model-instructions.md"),
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
      const store = createUserConfigStore({ configPath })

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
      await writeFile(
        configPath,
        'model_instructions_file = "missing-instructions.md"\n',
      )
      const store = createUserConfigStore({ configPath })

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

  it("merges trusted project layers root-to-cwd and reports leaf provenance", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      const nested = join(workspace, "packages", "app")
      await mkdir(join(workspace, ".yakitori"), { recursive: true })
      await mkdir(join(nested, ".yakitori"), { recursive: true })
      await writeFile(
        configPath,
        [
          'provider = "codex"',
          'model = "user-model"',
          `[projects."${workspace}"]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
      )
      await writeFile(
        join(workspace, ".yakitori", "config.toml"),
        'model = "root-model"\n',
      )
      await writeFile(
        join(nested, ".yakitori", "config.toml"),
        'effort = "high"\n',
      )
      const snapshot = await createUserConfigStore({
        configPath,
        workspaceRoot: workspace,
      }).readSnapshot({ cwd: nested })

      expect(snapshot.configuration.preference).toEqual({
        provider: "codex",
        model: "root-model",
        effort: "high",
      })
      expect(snapshot.layers).toHaveLength(3)
      expect(snapshot.origins.model).toMatchObject({
        source: "project",
        path: await realpath(join(workspace, ".yakitori", "config.toml")),
      })
      expect(snapshot.origins.effort).toMatchObject({
        source: "project",
        path: await realpath(join(nested, ".yakitori", "config.toml")),
      })
    })
  })

  it("loads untrusted project config as disabled without applying it", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      await mkdir(join(workspace, ".yakitori"), { recursive: true })
      await writeFile(configPath, 'provider = "codex"\nmodel = "user-model"\n')
      await writeFile(
        join(workspace, ".yakitori", "config.toml"),
        'model = "project-model"\n',
      )
      const snapshot = await createUserConfigStore({
        configPath,
        workspaceRoot: workspace,
      }).readSnapshot({ cwd: workspace })

      expect(snapshot.configuration.preference?.model).toBe("user-model")
      expect(snapshot.layers[1]).toMatchObject({
        source: "project",
        disabledReason: "project is not trusted",
      })
    })
  })

  it("lets an explicit untrusted child override a trusted parent", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      const child = join(workspace, "vendor", "untrusted")
      await mkdir(join(child, ".yakitori"), { recursive: true })
      await writeFile(
        configPath,
        [
          `[projects."${workspace}"]`,
          'trust_level = "trusted"',
          "",
          `[projects."${child}"]`,
          'trust_level = "untrusted"',
          "",
        ].join("\n"),
      )
      await writeFile(
        join(child, ".yakitori", "config.toml"),
        'model = "untrusted-model"\n',
      )

      const snapshot = await createUserConfigStore({
        configPath,
        workspaceRoot: workspace,
      }).readSnapshot({ cwd: child })

      expect(snapshot.configuration.preference).toBeUndefined()
      expect(snapshot.layers.at(-1)?.disabledReason).toBe(
        "project is explicitly untrusted",
      )
    })
  })

  it("rejects relative project trust paths", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      await mkdir(workspace, { recursive: true })
      await writeFile(configPath, '[projects."."]\ntrust_level = "trusted"\n')

      await expect(
        createUserConfigStore({
          configPath,
          workspaceRoot: workspace,
        }).readSnapshot({ cwd: workspace }),
      ).rejects.toThrow("Project trust path must be absolute")
    })
  })

  it("does not parse malformed project config before trust is established", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      await mkdir(join(workspace, ".yakitori"), { recursive: true })
      await writeFile(configPath, 'provider = "codex"\nmodel = "user-model"\n')
      await writeFile(
        join(workspace, ".yakitori", "config.toml"),
        "this is not valid = [toml",
      )

      const snapshot = await createUserConfigStore({
        configPath,
        workspaceRoot: workspace,
      }).readSnapshot({ cwd: workspace })

      expect(snapshot.configuration.preference?.model).toBe("user-model")
      expect(snapshot.layers[1]?.disabledReason).toBe("project is not trusted")
    })
  })

  it("rejects a stale user-layer fingerprint instead of overwriting it", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, 'provider = "codex"\nmodel = "one"\n')
      const store = createUserConfigStore({ configPath })
      const version = (await store.readSnapshot()).layers[0]?.version
      expect(version).toBeTypeOf("string")
      await writeFile(configPath, 'provider = "codex"\nmodel = "external"\n')

      await expect(
        store.writeValue({
          keyPath: ["model"],
          value: "ours",
          ...(version === undefined ? {} : { expectedVersion: version }),
        }),
      ).rejects.toThrow("modified since last read")
      expect(await readFile(configPath, "utf8")).toContain('model = "external"')
    })
  })

  it("holds the OS config lock across the complete write", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, 'provider = "codex"\nmodel = "one"\n')
      const externalLock = await open(
        `${configPath}.yakitori.lock`,
        "a+",
        0o600,
      )
      let locked = false
      try {
        await flockAsync(externalLock.fd, "ex")
        locked = true
        let settled = false
        const write = createUserConfigStore({ configPath })
          .writeValue({ keyPath: ["model"], value: "two" })
          .finally(() => {
            settled = true
          })

        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        expect(settled).toBe(false)

        await flockAsync(externalLock.fd, "un")
        locked = false
        await expect(write).resolves.toMatchObject({
          effective: { model: "two" },
        })
      } finally {
        if (locked) await flockAsync(externalLock.fd, "un")
        await externalLock.close()
      }
    })
  })

  it("rejects prototype-bearing key paths without changing Object.prototype", async () => {
    await withConfigPath(async (configPath) => {
      const store = createUserConfigStore({ configPath })

      await expect(
        store.writeValue({
          keyPath: ["__proto__", "yakitoriPolluted"],
          value: true,
        }),
      ).rejects.toThrow("invalid segment")
      expect(Object.hasOwn(Object.prototype, "yakitoriPolluted")).toBe(false)
    })
  })

  it("does not traverse inherited properties while writing a config path", async () => {
    await withConfigPath(async (configPath) => {
      await createUserConfigStore({ configPath }).writeValue({
        keyPath: ["toString", "enabled"],
        value: true,
      })

      expect(parse(await readFile(configPath, "utf8"))).toEqual({
        toString: { enabled: true },
      })
    })
  })

  it("represents large TOML integers exactly on the JSON wire", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, "extension_counter = 9007199254740993\n")

      const snapshot = await createUserConfigStore({
        configPath,
      }).readSnapshot()

      expect(snapshot.effective.extension_counter).toBe("9007199254740993")
      expect(() => JSON.stringify(snapshot)).not.toThrow()
    })
  })

  it("returns the requested project scope after a user config write", async () => {
    await withConfigPath(async (configPath) => {
      const workspace = join(dirname(configPath), "workspace")
      await mkdir(join(workspace, ".yakitori"), { recursive: true })
      await writeFile(
        configPath,
        [
          'provider = "codex"',
          'model = "user-model"',
          `[projects."${workspace}"]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
      )
      await writeFile(
        join(workspace, ".yakitori", "config.toml"),
        'model = "project-model"\n',
      )

      const snapshot = await createUserConfigStore({
        configPath,
        workspaceRoot: workspace,
      }).writeValue({
        keyPath: ["ui", "theme"],
        value: "dark",
        cwd: workspace,
      })

      expect(snapshot.layers).toHaveLength(2)
      expect(snapshot.configuration.preference).toEqual({
        provider: "codex",
        model: "project-model",
      })
      expect(snapshot.origins.model?.source).toBe("project")
    })
  })

  it("reports and treats malformed TOML as an empty preference", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, 'provider = "unterminated\nmodel = "x"\n')
      const failures: OperationalFailure[] = []
      const store = createUserConfigStore({
        configPath,
        reportOperationalFailure(failure) {
          failures.push(failure)
        },
      })

      await expect(store.read()).resolves.toBeUndefined()
      expect(failures).toEqual([
        {
          component: "user-config",
          operation: "parse",
          cause: expect.any(Error),
        },
      ])
    })
  })

  it("rejects a non-positive model context window as malformed config", async () => {
    await withConfigPath(async (configPath) => {
      await writeFile(configPath, "model_context_window = 0\n")
      const failures: OperationalFailure[] = []
      const store = createUserConfigStore({
        configPath,
        reportOperationalFailure(failure) {
          failures.push(failure)
        },
      })

      await expect(store.readConfiguration()).resolves.toEqual({})
      expect(failures).toEqual([
        {
          component: "user-config",
          operation: "parse",
          cause: expect.any(Error),
        },
      ])
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

function flockAsync(
  fileDescriptor: number,
  operation: "ex" | "un",
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    flock(fileDescriptor, operation, (error) => {
      if (error === null) resolvePromise()
      else rejectPromise(error)
    })
  })
}
