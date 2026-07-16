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

  return {
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
      include: ["test/**/*.test.ts"],
      restoreMocks: true,
    },
  }
})
