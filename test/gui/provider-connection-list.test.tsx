// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderConnectionList } from "../../src/gui/components/provider-connection-list.tsx"
import type { ApiConfiguredProvider } from "../../src/protocol/providers.ts"
afterEach(cleanup)
const provider: ApiConfiguredProvider = {
  id: "example",
  configuration: {
    name: "Example",
    wireApi: "openai_chat_completions",
    baseURL: "https://example.test",
    models: [],
  },
  credential: "stored",
}
it("opens account details from the arrow by pointer and keyboard without toggling the account", async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  const onEnabled = vi.fn()
  render(
    <ProviderConnectionList
      providers={[provider]}
      pending={false}
      onOpen={onOpen}
      onEnabled={onEnabled}
      onMove={vi.fn()}
    />,
  )
  const open = screen.getByRole("button", { name: "Open Example details" })
  await user.click(open)
  expect(onOpen).toHaveBeenLastCalledWith(provider)
  await user.keyboard("{Enter}")
  await user.keyboard(" ")
  expect(onOpen).toHaveBeenCalledTimes(3)
  expect(onEnabled).not.toHaveBeenCalled()
  await user.click(screen.getByRole("switch", { name: "Enable Example" }))
  expect(onEnabled).toHaveBeenCalledWith(provider, false)
  expect(onOpen).toHaveBeenCalledTimes(3)
})
