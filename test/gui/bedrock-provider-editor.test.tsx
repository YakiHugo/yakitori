// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ProviderEditor } from "../../src/gui/components/provider-editor.tsx"
import { providerPresets } from "../../src/runtime/provider-presets.ts"

afterEach(cleanup)
it("discloses static catalog, bearer-only US routing, long waits and no retries before connecting", () => {
  const preset = providerPresets.find((item) => item.id === "amazon-nova")
  if (!preset) throw new Error("Missing Nova preset")
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
      onTest={() => {}}
      onRemove={() => {}}
    />,
  )
  expect(screen.getByText(/static catalog/i)).toBeDefined()
  expect(
    screen.getByText(
      /bearer API key.*us-east-1.*not an AWS access key.*No IAM\/SigV4.*across US regions/i,
    ),
  ).toBeDefined()
  expect(screen.getByText(/up to 60 minutes/i)).toBeDefined()
  expect(screen.getByText(/not automatically retried/i)).toBeDefined()
})
