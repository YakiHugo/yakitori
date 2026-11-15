import { expect, test } from "@playwright/test"
import { createServer } from "vite"

const objective =
  "Complete the GUI diagnosis and repair the GoalBar layout so the final activity and Follow up text remain readable, the full objective can be read, and the composer stays close to the goal controls."

test("goal dock keeps output separate and long objectives readable", async ({
  page,
}, testInfo) => {
  // This renderer contract needs no server, provider, or persisted session.
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error("Missing renderer preview URL.")
    await page.goto(`${origin}?mock=transcript&sample=activity`)
    await page.getByText("Worked for 46s").waitFor()
    await page.evaluate(async (text) => {
      const modulePath = "/src/gui/store/app-store.ts"
      const { useAppStore } = (await import(
        modulePath
      )) as typeof import("../../src/gui/store/app-store.ts")
      const state = useAppStore.getState()
      const session = state.selectedSession
      if (session === undefined) throw new Error("Mock session is missing.")
      useAppStore.setState({
        execution: {
          ...state.execution,
          entries: state.execution.entries.map((entry) =>
            entry.kind === "assistant" && entry.itemId === "item_final_1"
              ? {
                  ...entry,
                  text: [
                    ...Array.from(
                      { length: 16 },
                      (_, index) =>
                        `Layout check ${index + 1}: Keep the activity history in its original reading order. Long output must scroll behind the input dock while the goal controls and composer remain readable.`,
                    ),
                    "Follow up: Read the final output above the goal controls, then scroll back through the activity history.",
                  ].join("\n\n"),
                }
              : entry,
          ),
        },
        selectedSession: {
          ...session,
          goal: {
            id: "goal_mock_layout",
            threadId: session.id,
            objective: text,
            status: "active",
            tokensUsed: 125_000,
            timeUsedSeconds: 9720,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
        },
      })
    }, objective)

    const goal = page.getByRole("region", { name: "Session goal" })
    await expect(goal).toContainText(objective)
    await expect(goal).toContainText("2h 42m active")
    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 800 })
      for (const dark of [false, true]) {
        await page.evaluate((value) => {
          document.documentElement.classList.toggle("dark", value)
          const viewport = document.querySelector(
            ".conversation-transcript-viewport",
          )
          if (viewport) viewport.scrollTop = viewport.scrollHeight
        }, dark)
        await expect
          .poll(() =>
            page.evaluate(() => {
              const content = document.querySelector(".conversation-content")
              const dock = document.querySelector(".conversation-dock")
              const goal = document.querySelector(".conversation-goal")
              const objective = goal?.querySelector("p")
              const form = document.querySelector(".conversation-composer")
              const main = document.querySelector("main")
              const viewport = document.querySelector(
                ".conversation-transcript-viewport",
              )
              const followup = Array.from(
                content?.querySelectorAll("p") ?? [],
              ).find((node) => node.textContent?.startsWith("Follow up:"))
              if (
                !content ||
                !dock ||
                !goal ||
                !objective ||
                !form ||
                !main ||
                !viewport ||
                !followup
              )
                throw new Error("Missing conversation layout.")
              const last = content.lastElementChild
              if (!last) throw new Error("Missing final transcript block.")
              const range = document.createRange()
              range.selectNodeContents(objective)
              return {
                overflowing: viewport.scrollHeight > viewport.clientHeight,
                outputAboveDock:
                  last.getBoundingClientRect().bottom <=
                  dock.getBoundingClientRect().top,
                finalOutputVisible:
                  followup.getBoundingClientRect().top >=
                    viewport.getBoundingClientRect().top &&
                  followup.getBoundingClientRect().bottom <=
                    dock.getBoundingClientRect().top,
                objectiveFits:
                  objective.scrollWidth <= objective.clientWidth &&
                  objective.scrollHeight <= objective.clientHeight,
                objectiveWraps: range.getClientRects().length > 1,
                composerGap: Math.round(
                  form.getBoundingClientRect().top -
                    goal.getBoundingClientRect().bottom,
                ),
              }
            }),
          )
          .toEqual({
            overflowing: true,
            outputAboveDock: true,
            finalOutputVisible: true,
            objectiveFits: true,
            objectiveWraps: true,
            composerGap: 8,
          })
        await expect(page.locator(".conversation-jump")).toHaveAttribute(
          "data-visible",
          "false",
        )
        await page.screenshot({
          path: testInfo.outputPath(
            `goal-${width}-${dark ? "dark" : "light"}.png`,
          ),
        })
        await page.locator(".conversation-transcript-viewport").hover()
        await page.mouse.wheel(0, -120)
        await expect
          .poll(() =>
            page
              .locator(".conversation-transcript-viewport")
              .evaluate(
                (node) =>
                  node.scrollHeight - node.clientHeight - node.scrollTop,
              ),
          )
          .toBeGreaterThan(24)
        await page.evaluate(() => {
          const viewport = document.querySelector(
            ".conversation-transcript-viewport",
          )
          const goal = document.querySelector(".conversation-goal")
          const followup = Array.from(
            document.querySelectorAll(".conversation-content p"),
          ).find((node) => node.textContent?.startsWith("Follow up:"))
          if (!viewport || !goal || !followup)
            throw new Error("Missing scroll-away layout.")
          viewport.scrollTop -=
            goal.getBoundingClientRect().top +
            12 -
            followup.getBoundingClientRect().top
        })
        await expect
          .poll(() =>
            page.evaluate(() => {
              const dock = document.querySelector(".conversation-dock")
              const goal = document.querySelector(".conversation-goal")
              const main = document.querySelector("main")
              const followup = Array.from(
                document.querySelectorAll(".conversation-content p"),
              ).find((node) => node.textContent?.startsWith("Follow up:"))
              if (!dock || !goal || !main || !followup)
                throw new Error("Missing scroll-away layout.")
              const goalBounds = goal.getBoundingClientRect()
              const outputBounds = followup.getBoundingClientRect()
              return {
                historyBehindGoal:
                  outputBounds.bottom > goalBounds.top &&
                  outputBounds.top < goalBounds.bottom,
                opaqueDock:
                  getComputedStyle(dock).backgroundColor ===
                  getComputedStyle(main).backgroundColor,
                dockAboveHistory: dock.contains(
                  document.elementFromPoint(
                    goalBounds.left + goalBounds.width / 2,
                    outputBounds.top + 1,
                  ),
                ),
              }
            }),
          )
          .toEqual({
            historyBehindGoal: true,
            opaqueDock: true,
            dockAboveHistory: true,
          })
        await page.screenshot({
          path: testInfo.outputPath(
            `goal-${width}-${dark ? "dark" : "light"}-scrolled.png`,
          ),
        })
      }
    }
  } finally {
    await server.close()
  }
})
