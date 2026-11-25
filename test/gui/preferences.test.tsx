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
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"])
})

afterEach(() => {
  cleanup()
  usePreferencesStore.setState(defaultPreferences)
  localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.documentElement.lang = "en"
})

describe("saved preferences", () => {
  it("persists partial updates and reloads them independently of current state", () => {
    usePreferencesStore.getState().updatePreferences({ appearance: "dark" })
    usePreferencesStore.getState().updatePreferences({
      language: "zh-CN",
      sendShortcut: "mod-enter",
      notificationMode: "always",
      notificationSound: false,
    })

    const saved = {
      language: "zh-CN",
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
      language: "system",
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
        language: "fr",
        appearance: "system",
        sendShortcut: "space",
        notificationMode: "off",
        notificationSound: "false",
        unrelated: true,
      }),
    )
    expect(readPreferences()).toEqual({
      language: "system",
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
      language: "system",
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

describe("interface language", () => {
  it("follows changes to supported system languages until the user overrides it", () => {
    const languages = vi.spyOn(navigator, "languages", "get")
    languages.mockReturnValue(["fr-FR", "zh-Hans-CN", "en-US"])
    useAppStore.setState({ settingsSection: "general" })
    render(
      <>
        <PreferencesEffects />
        <SettingsPage />
      </>,
    )

    expect(screen.getByRole("region", { name: "通用设置" })).toBeDefined()
    expect(document.documentElement.lang).toBe("zh-CN")

    act(() => {
      languages.mockReturnValue(["zh-TW", "en-US"])
      window.dispatchEvent(new Event("languagechange"))
    })
    expect(
      screen.getByRole("region", { name: "General settings" }),
    ).toBeDefined()
    expect(document.documentElement.lang).toBe("en")

    act(() =>
      usePreferencesStore.getState().updatePreferences({ language: "zh-CN" }),
    )
    window.dispatchEvent(new Event("languagechange"))
    expect(screen.getByRole("region", { name: "通用设置" })).toBeDefined()
    expect(document.documentElement.lang).toBe("zh-CN")
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
  it("uses a dedicated navigation surface and returns to the app", async () => {
    const closeSettings = vi.fn()
    useAppStore.setState({ settingsSection: "general", closeSettings })
    render(<SettingsPage />)

    expect(
      screen.getByRole("complementary", { name: "Settings navigation" }),
    ).toBeDefined()
    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).toBeDefined()

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to app" }))
    expect(closeSettings).toHaveBeenCalledOnce()
  })

  it("saves changes from general and notification controls", async () => {
    const user = userEvent.setup()
    useAppStore.setState({ settingsSection: "general" })
    render(<SettingsPage />)

    await user.click(screen.getByRole("combobox", { name: "Appearance" }))
    await user.click(screen.getByRole("option", { name: "System" }))
    await user.click(
      screen.getByRole("combobox", { name: "Send messages with" }),
    )
    await user.click(screen.getByRole("option", { name: "⌘ / Ctrl + Enter" }))
    await user.click(screen.getByRole("button", { name: "Notifications" }))
    await user.click(
      screen.getByRole("combobox", { name: "When work finishes" }),
    )
    await user.click(screen.getByRole("option", { name: "Always" }))
    await user.click(screen.getByRole("switch", { name: "Notification sound" }))

    expect(readPreferences()).toEqual({
      language: "system",
      appearance: "system",
      sendShortcut: "mod-enter",
      notificationMode: "always",
      notificationSound: false,
    })

    await user.click(
      screen.getByRole("combobox", { name: "When work finishes" }),
    )
    await user.click(screen.getByRole("option", { name: "Never" }))
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
    await user.click(appearance)
    await user.click(screen.getByRole("option", { name: "Dark" }))
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved",
    )
    expect(appearance.textContent).toBe("Light")

    await user.click(appearance)
    await user.click(screen.getByRole("option", { name: "Dark" }))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(appearance.textContent).toBe("Dark")
    expect(readPreferences().appearance).toBe("dark")
  })
})
