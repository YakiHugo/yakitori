// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { App } from "../../src/gui/app.tsx"
import {
  createInitialAppState,
  useAppStore,
} from "../../src/gui/store/app-store.ts"

beforeEach(() => {
  useAppStore.setState(createInitialAppState())
})

afterEach(() => {
  cleanup()
})

describe("app shell", () => {
  it("does not expose an API server switcher", () => {
    render(<App />)

    expect(screen.queryByRole("textbox", { name: "API" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
  })
})
