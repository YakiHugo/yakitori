import { defineConfig } from "vitest/config"

export default defineConfig({
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
})
