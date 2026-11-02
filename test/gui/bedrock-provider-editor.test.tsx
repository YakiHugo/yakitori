// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderEditor } from "../../src/gui/components/provider-editor.tsx"
import { providerPresets } from "../../src/runtime/provider-presets.ts"

afterEach(cleanup)
it("discloses static catalog, bearer-only US routing, buffered wait and no retries before connecting", () => {
  const preset = providerPresets.find((item) => item.id === "amazon-nova")
  if (!preset) throw new Error("Missing Nova preset")
  const testConnection = vi.fn()
  render(
    <ProviderEditor
      draft={{
        id: "nova",
        apiKey: "",
        existing: false,
        configuration: {
          ...preset,
          service: preset.id,
          authentication: "stored",
        },
      }}
      pending={false}
      testing={false}
      fetchingModels={false}
      onFetchModels={() => {}}
      onChange={() => {}}
      onClose={() => {}}
      onSubmit={() => {}}
      onApply={async () => {}}
      onTest={testConnection}
      onRemove={() => {}}
    />,
  )
  const disclosure = screen.getByText(/Nova 2 Lite only:/).textContent
  for (const text of [
    "static catalog",
    "buffered responses",
    "reasoning off",
    "us-east-1",
    "not an AWS access key",
    "No IAM/SigV4",
    "across US regions",
    "60 minutes",
    "not automatically retried",
    "does not verify the key",
  ])
    expect(disclosure).toContain(text)
  expect(testConnection).not.toHaveBeenCalled()
})
