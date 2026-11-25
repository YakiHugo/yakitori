import { expect, test } from "@playwright/test"
import { createServer } from "vite"
import type { ApiReadSubscriptionResponse } from "../../src/protocol/application.ts"

test("account usage follows the session route and browsing other accounts expires on dismiss", async ({
  page,
}, testInfo) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === "string")
      throw new Error("Missing renderer address")
    const reset = Date.UTC(2026, 11, 1, 12)
    const names = {
      work: "Work account",
      personal: "Personal account",
      sandbox: "Sandbox account",
    } as const
    await page.routeWebSocket("**/rpc", (socket) =>
      socket.onMessage((message) => {
        const input = JSON.parse(String(message)) as {
          id: number
          method: string
          params: { provider?: keyof typeof names; sessionId?: string }
        }
        let result: unknown = {}
        if (input.method === "model/preview") {
          result = {
            available: true,
            target: {
              provider: input.params.sessionId ? "personal" : "work",
              model: "sample",
            },
            efforts: [],
            speeds: [],
            inputModalities: ["text"],
            imageDetailModes: [],
            rejections: [],
          }
        }
        if (input.method === "subscription/read") {
          const account = input.params.provider
          if (!account || names[account] === undefined)
            throw new Error(`Expected an account ID, got ${account}`)
          result = {
            fetchedAt: Date.now(),
            subscription: {
              provider: account,
              displayName: names[account],
              availability: "available",
              ...(account === "work"
                ? {
                    plan: "pro",
                    usage: {
                      status: "available",
                      buckets: [
                        { name: "Weekly", usedPercent: 73, resetsAt: reset },
                        { name: "Daily", usedPercent: 58, resetsAt: reset },
                      ],
                    },
                  }
                : {
                    management: "chatgpt",
                    usage: { status: "unavailable", reason: "not_supported" },
                  }),
            },
          } satisfies ApiReadSubscriptionResponse
        }
        if (input.method === "usage/read")
          result = { usage: { recentAccountIds: ["sandbox", "personal"] } }
        if (input.method === "session/list") result = { sessions: [] }
        socket.send(JSON.stringify({ id: input.id, result }))
      }),
    )
    await page.goto(
      `http://127.0.0.1:${address.port}/test/smoke/renderer/sidebar-account-usage.html`,
    )
    const trigger = page.getByRole("button", { name: "Account usage" })
    const settings = page.getByRole("button", { name: "Settings", exact: true })
    expect((await trigger.boundingBox())?.y).toBeLessThan(
      (await settings.boundingBox())?.y ?? 0,
    )
    await trigger.hover()
    await expect(page.getByRole("tooltip")).toContainText(
      "27% remaining (Weekly)",
    )
    await trigger.click()
    const work = page.getByRole("dialog", { name: "Work account" })
    await expect(work.getByText("Pro plan")).toBeVisible()
    await expect(work.getByText("27% remaining")).toBeVisible()
    await expect(work.getByText("42% remaining")).toBeVisible()
    await expect(work.locator("time").first()).toHaveAttribute(
      "datetime",
      new Date(reset).toISOString(),
    )
    await page.screenshot({
      path: testInfo.outputPath("sidebar-account-usage.png"),
    })
    await work.getByRole("button", { name: "Other accounts" }).click()
    const choices = work.getByRole("list", { name: "Provider accounts" })
    await expect(choices.getByRole("listitem")).toHaveText([
      /Work account/,
      "Sandbox account",
      "Personal account",
    ])
    await choices.getByRole("button", { name: "Personal account" }).click()
    const personal = page.getByRole("dialog", { name: "Personal account" })
    await expect(
      personal.getByRole("link", { name: /Manage usage/ }),
    ).toHaveAttribute("href", "https://chatgpt.com/settings/usage")
    await page.keyboard.press("Escape")
    await expect(personal).toBeHidden()
    await trigger.click()
    await expect(work.getByText("27% remaining")).toBeVisible()
    await page.getByRole("button", { name: "Open second session" }).click()
    await trigger.click()
    await expect(personal.getByText("Next message")).toBeVisible()
    await expect(
      personal.getByRole("link", { name: /Manage usage/ }),
    ).toBeVisible()
    await expect(page.getByText("27% remaining", { exact: true })).toBeHidden()
    await page.keyboard.press("Escape")
    await expect(personal).toBeHidden()
    await page.keyboard.press("Control+,")
    const general = page.getByRole("region", { name: "General settings" })
    await expect(general).toBeVisible()
    await trigger.click()
    await expect(personal).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(personal).toBeHidden()
    await expect(general).toBeVisible()
  } finally {
    await server.close()
  }
})
