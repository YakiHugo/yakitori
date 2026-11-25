import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./test/smoke",
  // These process-boundary checks use isolated apps, with no retry masking.
  workers: process.env.CI ? 2 : 4,
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
        "input-submission.spec.ts",
        "browser-select.spec.ts",
        "browser-files.spec.ts",
        "browser-directory.spec.ts",
        "browser-chooser.spec.ts",
        "browser-dialogs.spec.ts",
        "browser-drag.spec.ts",
        "chatgpt-connections.spec.ts",
        "rendering.spec.ts",
        "gemini-citations.spec.ts",
        "hosted-tools.spec.ts",
        "acp-output.spec.ts",
        "account-financials.spec.ts",
        "sidebar-account-usage.spec.ts",
        "title-model.spec.ts",
        "app-update-renderer.spec.ts",
        "goal-renderer.spec.ts",
        "workspace-changes.spec.ts",
        "computer-panel.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop",
      testMatch: [
        "desktop.spec.ts",
        "browser-native.spec.ts",
        "app-update-desktop.spec.ts",
      ],
    },
  ],
})
