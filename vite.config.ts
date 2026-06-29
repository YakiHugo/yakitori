import { defineConfig } from "vitest/config"

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      fileName: "index",
      formats: ["es"],
    },
    sourcemap: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
})
