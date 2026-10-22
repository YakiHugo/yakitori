// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProviderUsage } from "../../src/gui/components/provider-usage.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ThreadUsageSummary } from "../../src/protocol/usage.ts"

const { request } = vi.hoisted(() => ({
  request:
    vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
}))
vi.mock("../../src/gui/lib/rpc-client.ts", () => ({
  getAppRpcClient: () => ({ request }),
}))
const summary: ThreadUsageSummary = {
  generatedAt: "2026-10-22T00:00:00Z",
  totals: {
    inputTokens: 1007,
    outputTokens: 13,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    turns: 2,
  },
  days: [
    {
      date: "2026-10-22",
      inputTokens: 1007,
      outputTokens: 13,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 2,
    },
  ],
  models: [
    {
      provider: "account-a",
      model: "shared-model",
      inputTokens: 17,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 1,
    },
    {
      provider: "account-b",
      model: "other-model",
      inputTokens: 990,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 1,
    },
  ],
  modelDays: [
    {
      provider: "account-a",
      model: "shared-model",
      date: "2026-10-22",
      inputTokens: 17,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 1,
    },
    {
      provider: "account-b",
      model: "other-model",
      date: "2026-10-22",
      inputTokens: 990,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      turns: 1,
    },
  ],
  threads: [],
}
beforeEach(() => {
  useAppStore.setState({
    ...createInitialAppState(),
    usage: { summary, loading: false },
    loadUsage: async () => {},
  })
  request.mockReset().mockImplementation(async (_method, params) => ({
    subscription: {
      provider: params.provider,
      displayName: "Selected account",
      availability: "available",
      usage: { status: "unavailable", reason: "not_supported" },
    },
    fetchedAt: 1,
  }))
})
afterEach(cleanup)

it("shows only the selected account's model usage and token totals", async () => {
  render(
    <ProviderUsage
      apiBase="/api"
      accountId="account-a"
      name="Work"
      chatGPT={false}
    />,
  )
  const usage = screen.getByRole("region", { name: "Provider usage" })
  expect(within(usage).getByText(/20 tokens/)).toBeDefined()
  expect(
    within(usage).getByRole("cell", { name: /Work shared-model/ }),
  ).toBeDefined()
  expect(within(usage).queryByText("other-model")).toBeNull()
  await screen.findByText("Connected")
  expect(request).toHaveBeenCalledWith("subscription/read", {
    provider: "account-a",
  })
  expect(request).toHaveBeenCalledTimes(1)
})

it("does not apply a previous account's late subscription response after navigation", async () => {
  let finish: ((value: unknown) => void) | undefined
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const view = render(
    <ProviderUsage
      key="a"
      apiBase="/api"
      accountId="account-a"
      name="Work"
      chatGPT={false}
    />,
  )
  view.rerender(
    <ProviderUsage
      key="b"
      apiBase="/api"
      accountId="account-b"
      name="Personal"
      chatGPT={false}
    />,
  )
  await screen.findByText("Connected")
  await act(async () =>
    finish?.({
      subscription: {
        provider: "account-a",
        displayName: "Wrong account",
        availability: "available",
        usage: {
          status: "available",
          buckets: [{ name: "Other account limits", usedPercent: 99 }],
        },
      },
      fetchedAt: 1,
    }),
  )
  expect(screen.queryByText("Other account limits")).toBeNull()
  expect(screen.getByText(/1K tokens/)).toBeDefined()
})

it("links the selected ChatGPT account to official usage without querying unrelated subscription accounts", () => {
  render(
    <ProviderUsage
      apiBase="/api"
      accountId="account-a"
      name="Personal"
      chatGPT
    />,
  )
  expect(
    screen.getByRole("link", { name: "Manage usage ↗" }).getAttribute("href"),
  ).toBe("https://chatgpt.com/settings/usage")
  expect(request).not.toHaveBeenCalled()
})
