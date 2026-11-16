import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { signDesktopApplication } from "../src/desktop/app-signing.ts"
import {
  buildDesktop,
  desktopCacheDirectory,
  desktopToolchain,
} from "./build-desktop.ts"
import { prepareDesktopBuildInfo } from "./build-desktop-info.ts"
import { cachedBuild, withBuildCacheLock } from "./lib/build-cache.ts"
import { capture, runBuild } from "./lib/build-process.ts"
import {
  installedPackages,
  packageInputs,
  runtimePackages,
  stagePackages,
} from "./lib/package-tree.ts"

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "Desktop packaging currently requires macOS on Apple Silicon.",
  )

await withBuildCacheLock(desktopCacheDirectory, async () => {
  await buildDesktop()
  // Electron downloads its binary lazily; initialize it before resolving electronDist.
  await runBuild("pnpm", ["exec", "electron", "--version"])
  const context = await desktopToolchain()
  const electron = JSON.parse(
    await readFile("node_modules/electron/package.json", "utf8"),
  ) as { version: string }
  const nativeProject = resolve(desktopCacheDirectory, "electron-addons")
  const nativeSources = await installedPackages(process.cwd(), [
    "fs-ext",
    "node-pty",
  ])
  const nativeInputs = packageInputs(nativeSources, true)
  const nativeContext = {
    context,
    electron: electron.version,
    clang: (await capture("clang", ["--version"])).stdout.trim(),
    sdk: (await capture("xcrun", ["--show-sdk-path"])).stdout.trim(),
    python: (await capture("python3", ["--version"])).stdout.trim(),
    npm: (await capture("npm", ["--version"])).stdout.trim(),
  }
  await cachedBuild(desktopCacheDirectory, {
    name: "electron-addons",
    inputs: [
      ...nativeInputs,
      { path: "pnpm-lock.yaml" },
      { path: "scripts/lib" },
      { path: "scripts/package-desktop-runtime.ts" },
      { path: "scripts/rebuild-electron-addons.ts" },
    ],
    context: nativeContext,
    outputs: [
      nativeProject,
      join(nativeProject, "node_modules/fs-ext/build/Release/fs_ext.node"),
      join(nativeProject, "node_modules/node-pty/build/Release/pty.node"),
    ],
    build: async () => {
      await rm(nativeProject, { recursive: true, force: true })
      await mkdir(nativeProject, { recursive: true })
      await writeFile(
        join(nativeProject, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: Object.fromEntries(
            nativeSources.map((pkg) => [pkg.name, pkg.version]),
          ),
        }),
      )
      await stagePackages(nativeProject, nativeSources)
      await runBuild(process.execPath, [
        "scripts/rebuild-electron-addons.ts",
        nativeProject,
        electron.version,
      ])
    },
  })
  const buildInfo = await prepareDesktopBuildInfo()
  const { builtAt: _builtAt, ...buildIdentity } = buildInfo
  const externalSources = await installedPackages(
    process.cwd(),
    runtimePackages,
  )
  const nativePackages = await installedPackages(nativeProject, [
    "fs-ext",
    "node-pty",
  ])
  const packages = externalSources.map(
    (pkg) => nativePackages.find((native) => native.name === pkg.name) ?? pkg,
  )
  const staging = resolve("build/desktop-package")
  const application = resolve("release/mac-arm64/Yakitori.app")
  await cachedBuild(desktopCacheDirectory, {
    name: "package",
    inputs: [
      ...[
        "dist/gui",
        "dist/desktop",
        "dist/native",
        "electron-builder.yml",
        "assets/app-icon",
        "package.json",
        "pnpm-lock.yaml",
        "scripts/lib",
        "scripts/package-desktop-runtime.ts",
        "scripts/build-desktop-info.ts",
        "scripts/verify-packaged-runtime.ts",
        "src/desktop/app-signing.ts",
        "node_modules/electron/dist",
        nativeProject,
      ].map((path) => ({ path })),
      ...packageInputs(externalSources),
    ],
    context: { nativeContext, buildIdentity },
    outputs: [
      application,
      join(application, "Contents/MacOS/Yakitori"),
      "dist/build-info.json",
    ],
    build: async () => {
      await writeFile(
        "dist/build-info.json",
        `${JSON.stringify(buildInfo, null, 2)}\n`,
      )
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      const manifest = JSON.parse(
        await readFile("package.json", "utf8"),
      ) as Record<string, unknown>
      delete manifest.devDependencies
      // The staging tree is ordinary copied node_modules. Explicitly select
      // npm's collector so builder cannot fall back to the workspace pnpm tree.
      manifest.packageManager = `npm@${nativeContext.npm}`
      delete manifest.scripts
      manifest.dependencies = Object.fromEntries(
        packages.map((pkg) => [pkg.name, pkg.version]),
      )
      await writeFile(
        join(staging, "package.json"),
        JSON.stringify(manifest, null, 2),
      )
      await cp("dist", join(staging, "dist"), { recursive: true })
      await stagePackages(staging, packages)
      await runBuild("pnpm", [
        "exec",
        "electron-builder",
        "--projectDir",
        staging,
        "--config",
        resolve("electron-builder.yml"),
        `--config.directories.output=${resolve("release")}`,
        `--config.electronDist=${resolve("node_modules/electron/dist")}`,
        `--config.electronVersion=${electron.version}`,
        `--config.mac.icon=${resolve("assets/app-icon/icon.icns")}`,
      ])
      await signDesktopApplication(application)
      await runBuild(process.execPath, ["scripts/verify-packaged-runtime.ts"])
    },
  })
})
