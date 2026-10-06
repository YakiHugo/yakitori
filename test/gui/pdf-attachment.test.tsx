// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { PdfAttachmentCard } from "../../src/gui/components/pdf-attachment.tsx"
const pdf = {
  name: "手册 (final).pdf",
  mediaType: "application/pdf" as const,
  sizeBytes: 120,
  file: {
    rolloutId: "rollout_a",
    path: "attachments/requests/input/manual.pdf",
  },
}
afterEach(() => {
  cleanup()
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: undefined,
  })
})
it("opens through the desktop bridge and downloads in place with a safely encoded filename", async () => {
  const openUrl = vi.fn(async () => {})
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { openUrl },
  })
  render(
    <PdfAttachmentCard attachment={pdf} apiBase="http://localhost:1234/" />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Open PDF" }))
  await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
  expect(openUrl.mock.calls[0]).toEqual([
    {
      url: "http://localhost:1234/rollouts/rollout_a/assets/attachments/requests/input/manual.pdf",
    },
  ])
  const link = screen.getByRole("link", { name: "Download PDF" })
  expect(
    new URL(link.getAttribute("href") ?? "").searchParams.get("download"),
  ).toBe(pdf.name)
  expect(link.getAttribute("download")).toBe(pdf.name)
  expect(link.getAttribute("target")).toBeNull()
  expect(openUrl).toHaveBeenCalledTimes(1)
})
it("reports failed opens and permits retry without exposing arbitrary references", async () => {
  const openUrl = vi
    .fn()
    .mockRejectedValueOnce(new Error("Open failed"))
    .mockResolvedValue(undefined)
  Object.defineProperty(window, "yakitoriDesktop", {
    configurable: true,
    value: { openUrl },
  })
  const view = render(
    <PdfAttachmentCard attachment={pdf} apiBase="http://localhost/" />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Open PDF" }))
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Open failed"),
  )
  fireEvent.click(screen.getByRole("button", { name: "Open PDF" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  view.rerender(
    <PdfAttachmentCard
      attachment={{
        ...pdf,
        file: { rolloutId: "rollout_a", path: "../secret" },
      }}
      apiBase="http://localhost/"
    />,
  )
  expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Open PDF" }))
  expect(screen.getByRole("alert").textContent).toBe(
    "PDF asset reference is invalid.",
  )
  expect(openUrl).toHaveBeenCalledTimes(2)
})
