// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PreferencesEffects } from "../../src/gui/components/preferences-effects.tsx"
import { SettingsPage } from "../../src/gui/components/settings-page.tsx"
import { useAppStore } from "../../src/gui/store/app-store.ts"
import {
  defaultPreferences,
  readPreferences,
  usePreferencesStore,
} from "../../src/gui/store/preferences-store.ts"

beforeEach(() => {
  localStorage.clear()
  usePreferencesStore.setState(defaultPreferences)
  document.documentElement.classList.remove("dark")
})

afterEach(() => {
  cleanup()
  usePreferencesStore.setState(defaultPreferences)
  localStorage.clear()
  document.documentElement.classList.remove("dark")
})

describe("saved preferences", () => {
  it("persists partial updates and reloads them independently of current state", () => {
    usePreferencesStore.getState().updatePreferences({ appearance: "dark" })
    usePreferencesStore.getState().updatePreferences({
      sendShortcut: "mod-enter",
      notificationMode: "always",
      notificationSound: false,
    })

    const saved = {
      appearance: "dark",
      sendShortcut: "mod-enter",
      notificationMode: "always",
      notificationSound: false,
    }
    expect(usePreferencesStore.getState()).toMatchObject(saved)
    usePreferencesStore.setState(defaultPreferences)
    expect(readPreferences()).toEqual(saved)
  })

  it.each([
    null,
    "{broken json",
    "null",
    "42",
    '"dark"',
    "[]",
  ])("uses defaults when storage has no valid preferences: %s", (saved) => {
    if (saved !== null) localStorage.setItem("yakitori.preferences", saved)

    expect(readPreferences()).toEqual({
      appearance: "light",
      sendShortcut: "enter",
      notificationMode: "unfocused",
      notificationSound: true,
    })
  })

  it("validates saved fields individually and ignores unrelated fields", () => {
    localStorage.setItem(
      "yakitori.preferences",
      JSON.stringify({
        appearance: "system",
        sendShortcut: "space",
        notificationMode: "off",
        notificationSound: "false",
        unrelated: true,
      }),
    )
    expect(readPreferences()).toEqual({
      appearance: "system",
      sendShortcut: "enter",
      notificationMode: "off",
      notificationSound: true,
    })

    localStorage.setItem(
      "yakitori.preferences",
      JSON.stringify({
        appearance: false,
        sendShortcut: "mod-enter",
        notificationMode: "sometimes",
        notificationSound: false,
      }),
    )
    expect(readPreferences()).toEqual({
      appearance: "light",
      sendShortcut: "mod-enter",
      notificationMode: "unfocused",
      notificationSound: false,
    })
  })

  it("does not publish an update when saving fails", () => {
    usePreferencesStore.getState().updatePreferences({ appearance: "dark" })
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage full", "QuotaExceededError")
    })

    expect(() =>
      usePreferencesStore.getState().updatePreferences({ appearance: "light" }),
    ).toThrow("Storage full")
    expect(usePreferencesStore.getState().appearance).toBe("dark")
    expect(readPreferences().appearance).toBe("dark")
  })
})

describe("appearance", () => {
  it("applies explicit themes and follows system changes only in system mode", () => {
    const media = Object.assign(new EventTarget(), {
      matches: true,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })
    vi.spyOn(window, "matchMedia").mockReturnValue(media)
    const { unmount } = render(<PreferencesEffects />)
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    act(() =>
      usePreferencesStore.getState().updatePreferences({ appearance: "dark" }),
    )
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() => {
      media.matches = false
      media.dispatchEvent(new Event("change"))
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() =>
      usePreferencesStore
        .getState()
        .updatePreferences({ appearance: "system" }),
    )
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    act(() => {
      media.matches = true
      media.dispatchEvent(new Event("change"))
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() => {
      media.matches = false
      media.dispatchEvent(new Event("change"))
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    unmount()
    media.matches = true
    media.dispatchEvent(new Event("change"))
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})

describe("settings page", () => {
  it("saves changes from general and notification controls", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ settingsSection: "general" })
    render(<SettingsPage />)

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Appearance" }),
      "system",
    )
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Send messages with" }),
      "mod-enter",
    )
    await user.click(screen.getByRole("button", { name: "Notifications" }))
    await user.selectOptions(
      screen.getByRole("combobox", { name: "When work finishes" }),
      "always",
    )
    await user.click(screen.getByRole("switch", { name: "Notification sound" }))

    expect(readPreferences()).toEqual({
      appearance: "system",
      sendShortcut: "mod-enter",
      notificationMode: "always",
      notificationSound: false,
    })

    await user.selectOptions(
      screen.getByRole("combobox", { name: "When work finishes" }),
      "off",
    )
    expect(
      screen.getByRole("switch", { name: "Notification sound" }),
    ).toHaveProperty("disabled", true)
    expect(readPreferences().notificationMode).toBe("off")
  })

  it("shows a failed save without changing the selected preference and allows retry", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ settingsSection: "general" })
    render(<SettingsPage />)
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage full", "QuotaExceededError")
    })

    const appearance = screen.getByRole("combobox", { name: "Appearance" })
    await user.selectOptions(appearance, "dark")
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved",
    )
    expect(appearance).toHaveProperty("value", "light")

    await user.selectOptions(appearance, "dark")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(appearance).toHaveProperty("value", "dark")
    expect(readPreferences().appearance).toBe("dark")
  })
})
