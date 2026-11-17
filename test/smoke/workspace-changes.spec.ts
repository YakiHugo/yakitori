import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type Browser,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test"
import {
  type ServerProcess,
  spawnServerProcess,
} from "../../src/desktop/server-process.ts"
import { createSmokeEnvironment } from "./fixtures.ts"

const executeFile = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await executeFile(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Changes Smoke",
      "-c",
      "user.email=changes@example.test",
      ...args,
    ],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    },
  )
  return result.stdout
}

async function reviewAndStageChanges(page: Page, cwd: string): Promise<void> {
  await page
    .getByRole("button", { name: "Show workspace", exact: true })
    .click()
  await expect(
    page.getByRole("tab", { name: "Changes", exact: true }),
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page.getByRole("heading", { name: "Review changes" }),
  ).toBeAttached()
  await expect(page.getByText("3 changed files", { exact: true })).toBeVisible()

  const tree = page
    .getByRole("navigation", { name: "Changed files", exact: true })
    .last()
  await expect(tree).toBeVisible()
  const workingFile = tree.getByRole("button", {
    name: "unstaged.txt, unstaged",
    exact: true,
  })
  const stagedFile = tree.getByRole("button", {
    name: "staged.txt, staged",
    exact: true,
  })
  const untrackedFile = tree.getByRole("button", {
    name: "src/new.ts, unstaged",
    exact: true,
  })
  await expect(workingFile).toContainText("+2")
  await expect(workingFile).toContainText("−1")
  await expect(stagedFile).toContainText("+2")
  await expect(stagedFile).toContainText("−1")
  await expect(untrackedFile).toBeVisible()
  const directory = tree.getByRole("button", { name: "src", exact: true })
  await expect(directory).toHaveAttribute("aria-expanded", "true")
  await directory.click()
  await expect(directory).toHaveAttribute("aria-expanded", "false")
  await expect(untrackedFile).toBeHidden()
  await directory.click()
  await expect(directory).toHaveAttribute("aria-expanded", "true")
  await expect(untrackedFile).toBeVisible()

  const scope = page.getByRole("combobox", {
    name: "Change scope",
    exact: true,
  })
  await scope.click()
  await page.getByRole("option", { name: "Staged", exact: true }).click()
  await expect(page.getByText("1 changed file", { exact: true })).toBeVisible()
  await expect(workingFile).toHaveCount(0)
  await expect(stagedFile).toBeVisible()
  await scope.click()
  await page.getByRole("option", { name: "All changes", exact: true }).click()
  await expect(page.getByText("3 changed files", { exact: true })).toBeVisible()

  await workingFile.click()
  await expect(workingFile).toHaveAttribute("aria-current", "true")
  const workingDiff = page.getByRole("region", {
    name: "Unstaged changes in unstaged.txt",
    exact: true,
  })
  await expect(workingDiff.locator('tr[data-kind="deletion"] code')).toHaveText(
    "-old working",
  )
  await expect(workingDiff.locator('tr[data-kind="addition"] code')).toHaveText(
    ["+new working", "+extra working"],
  )
  await stagedFile.click()
  await expect(stagedFile).toHaveAttribute("aria-current", "true")
  await expect(workingDiff).toHaveCount(0)
  const stagedDiff = page.getByRole("region", {
    name: "Staged changes in staged.txt",
    exact: true,
  })
  await expect(stagedDiff.locator('tr[data-kind="deletion"] code')).toHaveText(
    "-old staged",
  )
  await expect(stagedDiff.locator('tr[data-kind="addition"] code')).toHaveText([
    "+new staged",
    "+extra staged",
  ])
  await untrackedFile.click()
  await expect(untrackedFile).toHaveAttribute("aria-current", "true")
  const untrackedDiff = page.getByRole("region", {
    name: "Unstaged changes in src/new.ts",
    exact: true,
  })
  await expect(
    untrackedDiff.getByText("Untracked", { exact: true }),
  ).toBeVisible()
  await expect(
    untrackedDiff.locator('tr[data-kind="addition"] code'),
  ).toHaveText("+fresh untracked")
  await expect(
    page.getByRole("region", { name: "File diff", exact: true }),
  ).toHaveCount(1)

  await workingFile.click()
  await expect(workingFile).toHaveAttribute("aria-current", "true")
  await workingDiff
    .getByRole("button", { name: "Stage unstaged.txt", exact: true })
    .click()
  await expect(workingFile).toHaveCount(0)
  const newlyStaged = tree.getByRole("button", {
    name: "unstaged.txt, staged",
    exact: true,
  })
  await expect(newlyStaged).toContainText("+2")
  await expect(newlyStaged).toContainText("−1")
  await newlyStaged.click()
  await expect(newlyStaged).toHaveAttribute("aria-current", "true")
  const newlyStagedDiff = page.getByRole("region", {
    name: "Staged changes in unstaged.txt",
    exact: true,
  })
  await expect(
    newlyStagedDiff.locator('tr[data-kind="addition"] code'),
  ).toHaveText(["+new working", "+extra working"])
  await expect(
    newlyStagedDiff.getByRole("button", {
      name: "Unstage unstaged.txt",
      exact: true,
    }),
  ).toBeVisible()
  await expect(untrackedFile).toBeVisible()
  expect(
    await git(cwd, ["diff", "--cached", "--numstat", "--", "unstaged.txt"]),
  ).toBe("2\t1\tunstaged.txt\n")
  expect(await git(cwd, ["diff", "--numstat", "--", "unstaged.txt"])).toBe("")
}

test("Changes selects real Git diffs from the file tree and refreshes staged files", async ({
  playwright,
}, testInfo) => {
  const desktop = testInfo.project.name === "desktop"
  test.skip(
    desktop && process.platform !== "darwin",
    "Desktop verification requires macOS.",
  )
  const environment = await createSmokeEnvironment()
  const cwd = join(environment.root, "workspace")
  let server: ServerProcess | undefined
  let application: ElectronApplication | undefined
  let browser: Browser | undefined
  let target: Page
  const errors: string[] = []
  try {
    await git(cwd, ["init", "--quiet"])
    await writeFile(join(cwd, "staged.txt"), "old staged\n")
    await writeFile(join(cwd, "unstaged.txt"), "old working\n")
    await git(cwd, ["add", "."])
    await git(cwd, ["commit", "--quiet", "-m", "initial"])
    await writeFile(join(cwd, "staged.txt"), "new staged\nextra staged\n")
    await git(cwd, ["add", "--", "staged.txt"])
    await writeFile(join(cwd, "unstaged.txt"), "new working\nextra working\n")
    await mkdir(join(cwd, "src"))
    await writeFile(join(cwd, "src", "new.ts"), "fresh untracked\n")

    if (desktop) {
      // Launch the current build through the real main/preload/sidecar boundary.
      // The broader desktop suite separately verifies the packaged app artifact.
      application = await playwright._electron.launch({
        args: [
          resolve("."),
          `--user-data-dir=${join(environment.root, "electron-user-data")}`,
        ],
        cwd: environment.root,
        env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
        timeout: 30_000,
      })
      target = await application.firstWindow()
      await target.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/)
      expect(await target.evaluate(() => window.yakitoriDesktop)).toBeDefined()
    } else {
      browser = await playwright.chromium.launch()
      target = await browser.newPage()
      server = await spawnServerProcess({
        command: process.execPath,
        args: [resolve("src/server/start.ts")],
        cwd: environment.root,
        env: { ...environment.env, YAKITORI_GUI_DIR: resolve("dist/gui") },
      })
      await target.goto(server.url)
      expect(
        await target.evaluate(() => window.yakitoriDesktop),
      ).toBeUndefined()
    }
    target.on("pageerror", (error) => errors.push(error.message))
    await target.setViewportSize({ width: 1100, height: 900 })
    await reviewAndStageChanges(target, cwd)
    await expect(
      target.getByText("Loading diff…", { exact: true }),
    ).toHaveCount(0)
    expect(errors).toEqual([])
    await target
      .getByRole("button", { name: "Expand workspace", exact: true })
      .click()
    await target.screenshot({
      path: testInfo.outputPath(
        `workspace-changes-${testInfo.project.name}.png`,
      ),
    })
  } finally {
    try {
      await Promise.all([application?.close(), browser?.close()])
    } finally {
      try {
        await server?.stop()
      } finally {
        await environment.cleanup()
      }
    }
  }
})
