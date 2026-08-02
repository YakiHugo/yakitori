import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
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
      build: {
        // Node target: resolve node export conditions and skip package.json
        // "browser" field shims (e.g. @anthropic-ai/sdk's node.browser
        // chunks must not land in the Electron main bundle).
        ssr: true,
        lib: {
          entry: "src/desktop/main.ts",
          fileName: "main",
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
    server: {
      proxy: {
        "/health": "http://127.0.0.1:4141",
        "/sessions": "http://127.0.0.1:4141",
      },
    },
    test: {
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/gui/setup-localstorage.ts"],
      restoreMocks: true,
    },
  }
})
