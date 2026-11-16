import { readFile } from "node:fs/promises"
import { expect, type Page } from "@playwright/test"
import { createAppRpcClient } from "../../src/gui/lib/rpc-client.ts"
import { runFauxTurn } from "./fixtures.ts"

export async function runInputSubmissionFlow(
  page: Page,
  attachmentPath: string,
): Promise<void> {
  const held: Array<{ forward(): void; reply?: () => void }> = []
  const requests = new Map<number, (typeof held)[number]>()
  let holding = false
  await page.routeWebSocket("**/rpc", (socket) => {
    const peer = socket.connectToServer()
    socket.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { id?: number; method?: string }
        if (holding && frame.method === "session/input") {
          if (frame.id === undefined) throw new Error("Missing input RPC ID")
          const input = { forward: () => peer.send(message) }
          held.push(input)
          requests.set(frame.id, input)
          return
        }
        if (holding && frame.method === "session/input/steer")
          throw new Error("The renderer must let the server route input")
      }
      peer.send(message)
    })
    peer.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message) as { id?: number }
        const input =
          frame.id === undefined ? undefined : requests.get(frame.id)
        if (input) {
          input.reply = () => socket.send(message)
          return
        }
      }
      socket.send(message)
    })
  })
  await page.reload()
  await runFauxTurn(page)
  holding = true
  const composer = page.getByRole("textbox", { name: "Message the Mate" })
  const prompt = "Submit this attachment exactly once."
  const messages = (text: string) =>
    page
      .getByRole("main")
      .locator('[data-context-kind="message"]')
      .filter({ hasText: text })
      .filter({ visible: true })
  await composer.fill(prompt)
  const native = await page.evaluate(() => window.yakitoriDesktop !== undefined)
  await page.getByRole("button", { name: "Add context" }).click()
  const chooser = native ? undefined : page.waitForEvent("filechooser")
  await page.getByRole("option", { name: "Add images or PDFs" }).click()
  if (chooser) await (await chooser).setFiles(attachmentPath)
  const preview = page
    .locator("[data-composer-surface]")
    .getByRole("button", { name: "Preview smoke.png", exact: true })
  await expect(preview).toBeVisible()
  const source = await preview.locator("img").getAttribute("src")
  if (!source) throw new Error("Missing staging preview URL")
  await composer.press("Enter")
  await expect(messages(prompt)).toHaveCount(1)
  await expect(composer).toHaveText("")
  await expect(composer).toHaveAttribute("aria-disabled", "true")
  await expect(preview).toHaveCount(0)
  await composer.press("Enter")
  expect(held).toHaveLength(1)
  const staged = await page.request.get(source)
  expect(staged.status()).toBe(200)
  expect(await staged.body()).toEqual(await readFile(attachmentPath))

  held[0]?.forward()
  await expect.poll(() => held[0]?.reply !== undefined).toBe(true)
  // Durable input confirmation must release the composer even with the
  // transport acknowledgement withheld.
  await expect(composer).toHaveAttribute("aria-disabled", "false")
  await expect(messages(prompt)).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toHaveCount(0)

  const followup = "Start another input before the previous reply arrives."
  await composer.fill(followup)
  await composer.press("Enter")
  await expect(messages(followup)).toHaveCount(1)
  await expect(composer).toHaveAttribute("aria-disabled", "true")
  expect(held).toHaveLength(2)
  held[0]?.reply?.()
  held[1]?.forward()
  await expect.poll(() => held[1]?.reply !== undefined).toBe(true)
  await expect(composer).toHaveAttribute("aria-disabled", "false")
  held[1]?.reply?.()
  await expect(composer).toHaveText("")
  await expect(messages(prompt)).toHaveCount(1)
  await expect(messages(followup)).toHaveCount(1)
  const client = createAppRpcClient({ apiBase: new URL(page.url()).origin })
  try {
    const { sessions } = await client.request("session/list", {})
    expect(sessions).toHaveLength(1)
    const sessionId = sessions[0]?.id
    if (!sessionId) throw new Error("Missing submitted session")
    const { session } = await client.request("session/read", { sessionId })
    expect(session.counts.inputs).toBe(3)
    expect(
      (await client.request("session/queue/list", { sessionId })).items,
    ).toEqual([])
  } finally {
    client.close()
  }
}
