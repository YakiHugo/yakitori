import { execFile, spawn } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import {
  cachedBuild,
  fingerprint,
  withBuildCacheLock,
} from "../../scripts/lib/build-cache.ts"
import {
  installedPackages,
  packageInputs,
  stagePackages,
} from "../../scripts/lib/package-tree.ts"
import { electronAddonRebuildOptions } from "../../scripts/rebuild-electron-addons.ts"

const exec = promisify(execFile)

async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yakitori-build-cache-"))
  try {
    await action(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("content changes invalidate only the consuming stage, including same-size dirty edits", async () => {
  await fixture(async (root) => {
    const cache = join(root, "cache")
    const gui = join(root, "gui.ts")
    const swift = join(root, "helper.swift")
    await writeFile(gui, "before")
    await writeFile(swift, "swift")
    const builds: string[] = []
    const stage = (name: string, input: string, toolchain = "tool-v1") =>
      cachedBuild(cache, {
        name,
        inputs: [{ path: input }],
        context: toolchain,
        outputs: [join(root, `${name}.out`)],
        build: async () => {
          builds.push(name)
          // Cross a real process boundary so durable cache hits prevent subprocess work.
          await exec(process.execPath, [
            "-e",
            "require('fs').copyFileSync(process.argv[1],process.argv[2])",
            input,
            join(root, `${name}.out`),
          ])
        },
      })
    await stage("gui", gui)
    await stage("computer", swift)
    expect(await stage("gui", gui)).toBe("hit")
    const before = await stat(gui)
    await writeFile(gui, "after!")
    await utimes(gui, before.atime, before.mtime)
    expect(await stage("gui", gui)).toBe("built")
    expect(await stage("computer", swift)).toBe("hit")
    expect(await readFile(join(root, "gui.out"), "utf8")).toBe("after!")
    expect(await stage("gui", gui, "tool-v2")).toBe("built")
    expect(builds).toEqual(["gui", "computer", "gui", "gui"])
    expect((await readdir(cache)).sort()).toEqual(["computer.json", "gui.json"])
  })
})

test("missing, tampered, and mode-changed outputs are rebuilt and failed builds cannot hit", async () => {
  await fixture(async (root) => {
    const source = join(root, "input")
    const output = join(root, "output")
    const cache = join(root, "cache")
    await writeFile(source, "source")
    let fail = false
    const stage = () =>
      cachedBuild(cache, {
        name: "desktop",
        inputs: [{ path: source }],
        context: {},
        outputs: [output],
        build: async () => {
          await writeFile(output, "correct")
          await chmod(output, 0o755)
          if (fail) throw new Error("compile failed")
        },
      })
    await stage()
    await writeFile(output, "altered")
    expect(await stage()).toBe("built")
    expect(await readFile(output, "utf8")).toBe("correct")
    await chmod(output, 0o644)
    expect(await stage()).toBe("built")
    await rm(output)
    fail = true
    await expect(stage()).rejects.toThrow("compile failed")
    fail = false
    expect(await stage()).toBe("built")
    expect(await stage()).toBe("hit")
  })
})

test("directory membership and dependency bytes invalidate fingerprints while ignored build products do not", async () => {
  await fixture(async (root) => {
    const inputs = [
      {
        path: root,
        exclude: (name: string) =>
          name === "build" || name.startsWith("build/"),
      },
    ]
    await writeFile(join(root, "package.json"), '{"version":"1"}')
    const before = await fingerprint(inputs)
    await mkdir(join(root, "build"))
    await writeFile(join(root, "build", "generated"), "ignored")
    expect(await fingerprint(inputs)).toEqual(before)
    await writeFile(join(root, "untracked.ts"), "new source")
    expect(await fingerprint(inputs)).not.toEqual(before)
    await rm(join(root, "untracked.ts"))
    expect(await fingerprint(inputs)).toEqual(before)
    await writeFile(join(root, "package.json"), '{"version":"2"}')
    expect(await fingerprint(inputs)).not.toEqual(before)
  })
})

test("input edits during a build and corrupt cache records never produce a false hit", async () => {
  await fixture(async (root) => {
    const source = join(root, "input")
    const output = join(root, "output")
    const cache = join(root, "cache")
    await writeFile(source, "before")
    const stage = (edit = false) =>
      cachedBuild(cache, {
        name: "gui",
        inputs: [{ path: source }],
        context: null,
        outputs: [output],
        build: async () => {
          await writeFile(output, await readFile(source))
          if (edit) await writeFile(source, "during")
        },
      })
    await expect(stage(true)).rejects.toThrow("inputs changed")
    expect(await stage()).toBe("built")
    await writeFile(join(cache, "gui.json"), "{partial")
    expect(await stage()).toBe("built")
    expect(await readFile(output, "utf8")).toBe("during")
  })
})

test("the checkout lock rejects concurrent output mutation and releases after failure", async () => {
  await fixture(async (root) => {
    await expect(
      withBuildCacheLock(root, async () => {
        await expect(withBuildCacheLock(root, async () => {})).rejects.toThrow(
          "Another desktop build",
        )
        throw new Error("failed")
      }),
    ).rejects.toThrow("failed")
    expect(await withBuildCacheLock(root, async () => "released")).toBe(
      "released",
    )
  })
})

test("a killed build process releases its checkout lock for the next build", async () => {
  await fixture(async (root) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { withBuildCacheLock } = await import(process.argv[1]);
       await withBuildCacheLock(process.argv[2], async () => {
         await new Promise((_resolve, reject) => {
           process.on("message", () => {});
           process.send({ type: "build-cache-lock-held" }, (error) => {
             if (error) reject(error);
           });
         });
       });`,
        new URL("../../scripts/lib/build-cache.ts", import.meta.url).href,
        root,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    )
    let stderr = ""
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve())
    })
    try {
      const ready = await new Promise<unknown>((resolve, reject) => {
        const cleanup = () => {
          child.off("message", onMessage)
          child.off("error", onError)
          child.off("close", onClose)
        }
        const onMessage = (message: unknown) => {
          cleanup()
          resolve(message)
        }
        const onError = (error: Error) => {
          cleanup()
          reject(error)
        }
        const onClose = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          cleanup()
          reject(
            new Error(
              `Lock holder exited before readiness (${signal ?? code}): ${stderr}`,
            ),
          )
        }
        child.once("message", onMessage)
        child.once("error", onError)
        child.once("close", onClose)
      })
      expect(ready).toEqual({ type: "build-cache-lock-held" })
      expect(child.exitCode, stderr).toBeNull()
      expect(child.signalCode, stderr).toBeNull()
      expect(child.connected, stderr).toBe(true)
      await expect(withBuildCacheLock(root, async () => {})).rejects.toThrow(
        "Another desktop build",
      )
      expect(child.kill("SIGKILL")).toBe(true)
      await closed
      expect(child.signalCode, stderr).toBe("SIGKILL")
      expect(await withBuildCacheLock(root, async () => "available")).toBe(
        "available",
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL")
      await closed
    }
  })
})

test("staged addons and their private build dependencies are copies independent of workspace modules", async () => {
  await fixture(async (root) => {
    const source = join(root, "workspace")
    const destination = join(root, "isolated")
    const addon = join(source, "node_modules", "addon")
    const dependency = join(addon, "node_modules", "headers")
    await mkdir(dependency, { recursive: true })
    await mkdir(destination)
    await writeFile(join(source, "package.json"), "{}")
    await writeFile(
      join(addon, "package.json"),
      JSON.stringify({
        name: "addon",
        version: "1.0.0",
        dependencies: { headers: "2.0.0" },
        optionalDependencies: { "uninstalled-platform": "1.0.0" },
      }),
    )
    await writeFile(join(addon, "binding.cc"), "original")
    await writeFile(
      join(dependency, "package.json"),
      '{"name":"headers","version":"2.0.0","main":"index.js"}',
    )
    await writeFile(
      join(dependency, "index.js"),
      'module.exports="private-headers"',
    )
    const packages = await installedPackages(source, ["addon"])
    const inputs = packageInputs(packages)
    const before = await fingerprint(inputs)
    await stagePackages(destination, packages)
    await exec(process.execPath, [
      "-e",
      `
      const fs = require("fs");
      const path = require("path");
      const addon = process.argv[1];
      fs.writeFileSync(path.join(addon, "binding.cc"), require(path.join(addon,"node_modules/headers")));
    `,
      join(destination, "node_modules/addon"),
    ])
    expect(await readFile(join(addon, "binding.cc"), "utf8")).toBe("original")
    expect(await fingerprint(inputs)).toEqual(before)
    expect(
      await readFile(
        join(destination, "node_modules/addon/binding.cc"),
        "utf8",
      ),
    ).toBe("private-headers")
    await writeFile(
      join(dependency, "index.js"),
      'module.exports="changed-headers"',
    )
    expect(await fingerprint(inputs)).not.toEqual(before)
  })
})

test("Electron Rebuild discovers staged addons once and excludes identical ancestor workspace addons", async () => {
  await fixture(async (root) => {
    const isolated = join(root, "build", "isolated")
    await mkdir(join(root, "build"), { recursive: true })
    await writeFile(join(root, "build", "package.json"), "{}")
    for (const project of [root, isolated]) {
      await mkdir(project, { recursive: true })
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          dependencies: { "fs-ext": "1.0.0", "node-pty": "1.0.0" },
        }),
      )
      for (const name of ["fs-ext", "node-pty"]) {
        const addon = join(project, "node_modules", name)
        await mkdir(addon, { recursive: true })
        await writeFile(
          join(addon, "package.json"),
          JSON.stringify({ name, version: "1.0.0" }),
        )
        await writeFile(join(addon, "binding.gyp"), "{}")
      }
    }
    const { rebuild } = await import("@electron/rebuild")
    async function discover(projectRootPath: string): Promise<string[]> {
      const task = rebuild({
        ...electronAddonRebuildOptions(isolated, "43.2.0"),
        projectRootPath,
        // Exercise the real installed dependency walker without compiling fixtures.
        ignoreModules: ["fs-ext", "node-pty"],
      })
      let discovered: string[] = []
      task.lifecycle.on("modules-found", (names: string[]) => {
        discovered = names
      })
      await task
      return discovered.sort()
    }
    // Control reproduces the CLI's workspace-wide root and the observed duplicate queue.
    expect(await discover(root)).toEqual([
      "fs-ext",
      "fs-ext",
      "node-pty",
      "node-pty",
    ])
    const options = electronAddonRebuildOptions(isolated, "43.2.0")
    expect(await discover(options.projectRootPath ?? "")).toEqual([
      "fs-ext",
      "node-pty",
    ])
  })
})
