import { readdir, readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  cachedBuild,
  fingerprint,
  withBuildCacheLock,
} from "./lib/build-cache.ts"
import { capture, runBuild } from "./lib/build-process.ts"
import { installedPackages, packageInputs } from "./lib/package-tree.ts"

export const desktopCacheDirectory = resolve("build/local-cache")

export async function desktopToolchain(): Promise<unknown> {
  return {
    node: process.version,
    nodeExecutable: await realpath(process.execPath),
    platform: process.platform,
    arch: process.arch,
    environment: Object.fromEntries(
      Object.entries(process.env)
        .filter(([name]) =>
          /^(VITE_|NODE_ENV$|NODE_OPTIONS$|YAKITORI_CODESIGN_IDENTITY$|SDKROOT$|DEVELOPER_DIR$|MACOSX_DEPLOYMENT_TARGET$|CC$|CXX$|CFLAGS$|CXXFLAGS$|LDFLAGS$|PYTHON$|npm_config_|ELECTRON_REBUILD_)/.test(
            name,
          ),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    pnpm: (await capture("pnpm", ["--version"])).stdout.trim(),
  }
}

/** Packaging reuses outputs; ordinary `pnpm build` remains a full developer build. */
export async function buildDesktop(): Promise<void> {
  const toolchain = await desktopToolchain()
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  const packages = await installedPackages(
    process.cwd(),
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }),
  )
  // pnpm's lockfile/store owns bundled dependency bytes. Check the installed
  // manifests too, so a different installed dependency graph invalidates reuse.
  // Native addon source/build inputs are hashed in full by the package stage.
  const dependencies = await fingerprint(
    packageInputs(packages).map(({ path }) => ({
      path: join(path, "package.json"),
    })),
  )
  const context = { toolchain, dependencies: dependencies.digest }
  const common = [
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "tsconfig.json",
    "scripts/build-desktop.ts",
    "scripts/lib",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
    ".npmrc",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.desktop",
    ".env.desktop.local",
  ].map((path) => ({ path }))
  const sourceDirectories = await readdir("src")
  await cachedBuild(desktopCacheDirectory, {
    name: "gui",
    inputs: [
      ...common,
      ...[
        "src/gui",
        "src/shared",
        "src/protocol",
        "src/desktop",
        "index.html",
        "public",
      ].map((path) => ({ path })),
    ],
    context,
    outputs: ["dist/gui", "dist/gui/index.html"],
    build: async () => {
      await runBuild("pnpm", ["build:gui"])
    },
  })
  if (process.platform === "darwin") {
    const swift = (await capture("swift", ["--version"])).stdout.trim()
    const sdk = (await capture("xcrun", ["--show-sdk-path"])).stdout.trim()
    const clang = (await capture("clang", ["--version"])).stdout.trim()
    await cachedBuild(desktopCacheDirectory, {
      name: "computer",
      inputs: [
        {
          path: "native/computer",
          exclude: (name) => name.startsWith(".build/") || name === ".build",
        },
        { path: "scripts/build-computer.ts" },
      ],
      context: { toolchain, swift, sdk, clang },
      outputs: [
        "dist/native/Yakitori Computer.app",
        "dist/native/Yakitori Computer.app/Contents/MacOS/yakitori-computer",
      ],
      build: async () => {
        await runBuild("pnpm", ["build:computer"])
      },
    })
  }
  await cachedBuild(desktopCacheDirectory, {
    name: "desktop",
    inputs: [
      ...common,
      ...sourceDirectories
        .filter((name) => name !== "gui")
        .map((name) => ({ path: join("src", name) })),
      { path: "scripts/verify-desktop-prompts.ts" },
    ],
    context,
    outputs: [
      "dist/desktop",
      "dist/desktop/main.js",
      "dist/desktop/preload.cjs",
    ],
    build: async () => {
      await runBuild("pnpm", ["exec", "vite", "build", "--mode", "desktop"])
      await runBuild(process.execPath, ["scripts/verify-desktop-prompts.ts"])
    },
  })
}

if (import.meta.main) {
  await withBuildCacheLock(desktopCacheDirectory, buildDesktop)
}
