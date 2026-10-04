// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import {
  ProviderEditor,
  type ProviderDraft,
} from "../../src/gui/components/provider-editor.tsx"
afterEach(cleanup)
function editor(
  baseURL = "https://api.openai.com/v1",
  requestWarmup?: boolean,
) {
  const changed = vi.fn<(draft: ProviderDraft) => void>()
  render(
    <ProviderEditor
      draft={{
        id: "api",
        apiKey: "",
        existing: true,
        configuration: {
          name: "API",
          wireApi: "openai_responses",
          baseURL,
          models: [],
          ...(requestWarmup === undefined ? {} : { requestWarmup }),
        },
      }}
      pending={false}
      testing={false}
      fetchingModels={false}
      onFetchModels={() => {}}
      onChange={changed}
      onClose={() => {}}
      onSubmit={() => {}}
      onTest={() => {}}
      onRemove={() => {}}
    />,
  )
  return changed
}
it("shows the optional usage disclosure before enabling API request warmup", () => {
  const changed = editor()
  const toggle = screen.getByRole("checkbox", {
    name: "Prepare the next request while tools run",
    hidden: true,
  }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  expect(screen.getByText(/may incur API usage/)).toBeTruthy()
  fireEvent.click(toggle)
  expect(changed.mock.lastCall?.[0].configuration.requestWarmup).toBe(true)
})
it("removes the capability when an enabled connection changes endpoint", () => {
  const changed = editor("https://api.openai.com/v1", true)
  fireEvent.change(screen.getByLabelText("API base URL"), {
    target: { value: "https://relay.example/v1" },
  })
  expect(changed.mock.lastCall?.[0].configuration.requestWarmup).toBe(false)
})
it("does not offer warmup on a subscription or compatible endpoint", () => {
  editor("https://chatgpt.com/backend-api/codex")
  expect(
    screen.queryByRole("checkbox", {
      name: "Prepare the next request while tools run",
      hidden: true,
    }),
  ).toBeNull()
})
