// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ContextWindowIndicator } from "../../src/gui/components/context-window-indicator.tsx"

afterEach(cleanup)

it("shows the latest context use against the effective model window", () => {
  render(<ContextWindowIndicator usedTokens={108_000} capacity={258_000} />)

  expect(
    screen.getByRole("button", {
      name: "Context window: 42% used, 58% remaining",
    }),
  ).toBeTruthy()
  expect(screen.getByRole("tooltip").textContent).toContain(
    "108k tokens used, 258k total",
  )
})

it("does not claim a percentage before the model has reported context use", () => {
  render(<ContextWindowIndicator capacity={258_000} />)

  expect(
    screen.getByRole("button", { name: "Context window usage unavailable" }),
  ).toBeTruthy()
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Usage available after a model response",
  )
})
