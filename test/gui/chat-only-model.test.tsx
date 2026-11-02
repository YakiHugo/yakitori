// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ModelSelector } from "../../src/gui/components/model-selector.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"
import type { ModelRoutePreview } from "../../src/protocol/model-routing.ts"

afterEach(() => {
  cleanup()
  useAppStore.setState(createInitialAppState())
})

it("shows the actual route restriction and keeps the directory label after menu dismissal", () => {
  const selection = { provider: "tencent", model: "vision" }
  useAppStore.setState({
    ...createInitialAppState(),
    providers: [
      {
        name: "tencent",
        models: [
          {
            id: "vision",
            displayName: "Vision",
            instructionProfileId: "default",
            toolPolicy: "chat_only",
          },
        ],
      },
    ],
  })
  const preview: ModelRoutePreview = {
    available: true,
    target: selection,
    efforts: [],
    speeds: [],
    inputModalities: ["text", "image"],
    imageDetailModes: ["high"],
    rejections: [],
  }
  const change = vi.fn()
  const view = render(
    <ModelSelector
      selection={selection}
      onChange={change}
      routePreview={{ value: { ...preview, toolPolicy: "chat_only" } }}
    />,
  )
  expect(screen.getByRole("status").textContent).toBe(
    "Text/image chat only — no tools or file access",
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Select model and effort" }),
  )
  expect(
    screen.getByRole("button", { name: "Vision · Chat only (no tools)" }),
  ).toBeDefined()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.getByRole("status")).toBeDefined()
  // An explicitly selected unrestricted relay route must not inherit the
  // direct account's chat-only state from the logical directory.
  view.rerender(
    <ModelSelector
      selection={selection}
      onChange={change}
      routePreview={{
        value: { ...preview, target: { provider: "relay", model: "alias" } },
      }}
    />,
  )
  expect(screen.queryByRole("status")).toBeNull()
  view.rerender(
    <ModelSelector
      selection={selection}
      onChange={change}
      routePreview={{ value: undefined }}
    />,
  )
  expect(screen.getByRole("status")).toBeDefined()
  expect(change).not.toHaveBeenCalled()
})
