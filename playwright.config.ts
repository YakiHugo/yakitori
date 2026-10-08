import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./test/smoke",
  // These process-boundary checks use isolated apps, with no retry masking.
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/smoke",
  reporter: [["line"], ["junit", { outputFile: "test-results/smoke.xml" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "browser",
      testMatch: [
        "browser.spec.ts",
        "chatgpt-connections.spec.ts",
        "rendering.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "desktop", testMatch: "desktop.spec.ts" },
  ],
})
