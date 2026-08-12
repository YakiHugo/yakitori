import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => {
  if (mode === "lib") {
    return {
      build: {
        lib: {
          entry: "src/index.ts",
          fileName: "index",
          formats: ["es"],
        },
        rollupOptions: {
          external: [/^node:/],
        },
        sourcemap: true,
      },
      test: {
        include: ["test/**/*.test.ts"],
        restoreMocks: true,
      },
    }
  }

  if (mode === "desktop") {
    return {
      // Prompt markdown ships as assets next to the bundle so the runtime
      // reads real files; verify-desktop-prompts guards the copy.
      plugins: [desktopPromptAssets()],
      build: {
        // Node target: resolve node export conditions and skip package.json
        // "browser" field shims (e.g. @anthropic-ai/sdk's node.browser
        // chunks must not land in the Electron main bundle).
        ssr: true,
        lib: {
          entry: {
            main: "src/desktop/main.ts",
            // The sidecar server entry runs under plain Node
            // (ELECTRON_RUN_AS_NODE) in the packaged app.
            server: "src/server/desktop-entry.ts",
          },
          fileName: (_format, entryName) => `${entryName}.js`,
          formats: ["es"],
        },
        outDir: "dist/desktop",
        rollupOptions: {
          external: ["electron", /^node:/],
        },
        sourcemap: true,
      },
      ssr: {
        // SSR builds externalize dependencies by default; the desktop bundle
        // inlines every npm dependency except electron and node builtins.
        noExternal: true,
      },
      test: {
        include: ["test/**/*.test.ts"],
        restoreMocks: true,
      },
    }
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/gui", import.meta.url)),
      },
    },
    build: {
      outDir: "dist/gui",
      sourcemap: true,
    },
    // No dev-server proxy: the renderer always talks to the API origin
    // directly (the Electron shell appends ?api=<sidecar-url>), so a new
    // route can never silently 404 behind a missing proxy entry.
    test: {
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/gui/setup-localstorage.ts"],
      restoreMocks: true,
    },
  }
})

function desktopPromptAssets(): Plugin {
  const promptDirectory = fileURLToPath(
    new URL("./src/runtime/prompts", import.meta.url),
  )
  return {
    name: "yakitori-desktop-prompt-assets",
    generateBundle() {
      for (const fileName of readdirSync(promptDirectory)) {
        if (!fileName.endsWith(".md")) continue
        this.emitFile({
          type: "asset",
          fileName: `prompts/${fileName}`,
          source: readFileSync(`${promptDirectory}/${fileName}`),
        })
      }
    },
  }
}
