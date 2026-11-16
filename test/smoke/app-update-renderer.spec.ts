import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import type {
  DesktopBuildInfo,
  DesktopUpdateBridge,
  DesktopUpdateRelease,
  DesktopUpdateState,
} from "../../src/protocol/desktop-update.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

type UpdateSmoke = {
  calls: ("download" | "install" | "check")[]
  emit(state: DesktopUpdateState): void
}

test("desktop update rail guides download, retry, and explicit restart in the browser renderer", async ({
  page,
}, testInfo) => {
  const environment = await createSmokeEnvironment()
  let server: ServerProcess | undefined
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  // Only the native update bridge is scripted. The built renderer, browser
  // layout/focus, and isolated faux server are real; native preparation is
  // covered by its own desktop tests.
  await page.addInitScript(() => {
    const current: DesktopBuildInfo = {
      repository: "YakiHugo/yakitori",
      version: "0.0.0",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      dirty: true,
      channel: "local",
      buildNumber: 41,
      buildAttempt: 1,
      builtAt: "2026-11-14T00:00:00Z",
      platform: "darwin",
      arch: "arm64",
    }
    const release: DesktopUpdateRelease = {
      version: "0.0.0",
      commit: "123456789abcdef0123456789abcdef0123456789",
      buildNumber: 42,
      buildAttempt: 1,
      publishedAt: "2026-11-15T00:00:00Z",
      releaseUrl: "https://example.test/releases/42",
    }
    let state: DesktopUpdateState = { phase: "available", current, release }
    const listeners = new Set<(state: DesktopUpdateState) => void>()
    const smoke: UpdateSmoke = {
      calls: [],
      emit(next) {
        state = next
        for (const listener of listeners) listener(state)
      },
    }
    const updates: DesktopUpdateBridge = {
      async getState() {
        return state
      },
      async check() {
        smoke.calls.push("check")
      },
      async download() {
        smoke.calls.push("download")
        smoke.emit({
          phase: "downloading",
          current,
          release,
          downloadedBytes: 25,
          totalBytes: 100,
        })
      },
      async install() {
        smoke.calls.push("install")
        smoke.emit({ phase: "installing", current, release })
      },
      onState(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    Object.defineProperty(window, "yakitoriDesktop", {
      value: { platform: "darwin", updates },
      configurable: true,
    })
    Object.defineProperty(window, "appUpdateSmoke", { value: smoke })
  })

  try {
    server = await spawnServerProcess({
      command: process.execPath,
      args: [resolve("src/server/start.ts")],
      cwd: environment.root,
      env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
    })
    await page.goto(server.url)
    const rail = page.getByRole("navigation", { name: "App navigation" })
    const available = rail.getByRole("button", {
      name: "Update available",
      exact: true,
    })
    const settings = rail.getByRole("button", { name: "Settings", exact: true })
    await expect(available).toBeVisible()
    const updateBounds = await available.boundingBox()
    const settingsBounds = await settings.boundingBox()
    if (!updateBounds || !settingsBounds)
      throw new Error("Rail buttons have no layout")
    expect(updateBounds.y + updateBounds.height).toBeLessThan(settingsBounds.y)
    expect(Math.abs(updateBounds.x - settingsBounds.x)).toBeLessThan(2)
    await available.click()
    const popover = page.getByRole("dialog", {
      name: "Update available",
      exact: true,
    })
    await expect(popover).toBeFocused()
    await expect(popover).toContainText("abcdef0 · Local build")
    await expect(popover).toContainText("1234567 · Build 42")
    await expect(popover).toContainText("Updating replaces this local build.")
    const availableScreenshot = testInfo.outputPath("app-update-available.png")
    await page.screenshot({ path: availableScreenshot })
    await testInfo.attach("Update available", {
      path: availableScreenshot,
      contentType: "image/png",
    })

    await page.keyboard.press("Escape")
    await expect(popover).toHaveCount(0)
    await expect(available).toBeFocused()
    await available.click()
    await rail.getByRole("button", { name: "Chats", exact: true }).click()
    await expect(popover).toHaveCount(0)
    await available.click()
    await page
      .getByRole("button", { name: "Download update", exact: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (Reflect.get(window, "appUpdateSmoke") as UpdateSmoke).calls,
        ),
      )
      .toEqual(["download"])
    await expect(
      page.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("value", "25")

    await page.evaluate(() => {
      const smoke = Reflect.get(window, "appUpdateSmoke") as UpdateSmoke
      const bridge = window.yakitoriDesktop?.updates
      if (!bridge) throw new Error("Missing update bridge")
      return bridge.getState().then((state) => {
        if (state.phase !== "downloading")
          throw new Error("Expected active download")
        smoke.emit({ ...state, downloadedBytes: 75 })
      })
    })
    await expect(
      page.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("value", "75")
    await page.evaluate(async () => {
      const state = await window.yakitoriDesktop?.updates.getState()
      if (state?.phase !== "downloading")
        throw new Error("Missing active download")
      const smoke = Reflect.get(window, "appUpdateSmoke") as UpdateSmoke
      smoke.emit({
        phase: "error",
        current: state.current,
        release: state.release,
        message: "The connection was interrupted. Try downloading again.",
        retry: "download",
      })
    })
    await expect(page.getByRole("alert")).toHaveText(
      "The connection was interrupted. Try downloading again.",
    )
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (Reflect.get(window, "appUpdateSmoke") as UpdateSmoke).calls,
        ),
      )
      .toEqual(["download", "download"])
    await expect(
      page.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("value", "25")

    await page.evaluate(async () => {
      const state = await window.yakitoriDesktop?.updates.getState()
      if (state?.phase !== "downloading")
        throw new Error("Missing active download")
      const smoke = Reflect.get(window, "appUpdateSmoke") as UpdateSmoke
      smoke.emit({
        phase: "ready",
        current: state.current,
        release: state.release,
      })
    })
    await expect(
      rail.getByRole("button", { name: "Restart to update", exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole("dialog", { name: "Restart to update", exact: true }),
    ).toContainText("The update is ready.")
    await expect
      .poll(() =>
        page.evaluate(
          () => (Reflect.get(window, "appUpdateSmoke") as UpdateSmoke).calls,
        ),
      )
      .toEqual(["download", "download"])
    const readyScreenshot = testInfo.outputPath("app-update-ready.png")
    await page.screenshot({ path: readyScreenshot })
    await testInfo.attach("Update ready", {
      path: readyScreenshot,
      contentType: "image/png",
    })
    await page
      .getByRole("button", { name: "Restart and update", exact: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (Reflect.get(window, "appUpdateSmoke") as UpdateSmoke).calls,
        ),
      )
      .toEqual(["download", "download", "install"])
    await expect(
      rail.getByRole("button", { name: "Installing update", exact: true }),
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Restart and update", exact: true }),
    ).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await server?.stop()
    await environment.cleanup()
  }
})
