// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { SidebarMenu } from "../../src/gui/components/sidebar-surfaces.tsx"
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("refreshes action closure and checked state without retaining the original props", async () => {
  const old = vi.fn()
  const fresh = vi.fn()
  const view = render(
    <SidebarMenu
      label="Actions"
      items={[
        {
          label: "Move",
          items: [{ label: "Same label", checked: false, action: old }],
        },
      ]}
    >
      {null}
    </SidebarMenu>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  view.rerender(
    <SidebarMenu
      label="Actions"
      items={[
        {
          label: "Move",
          items: [{ label: "Same label", checked: true, action: fresh }],
        },
      ]}
    >
      {null}
    </SidebarMenu>,
  )
  const item = screen.getByRole("menuitemradio", { name: "Same label" })
  expect(item.getAttribute("aria-checked")).toBe("true")
  await user.click(item)
  expect(fresh).toHaveBeenCalledTimes(1)
  expect(old).not.toHaveBeenCalled()
})

it("does not expose actions from a vanished or renamed submenu parent", async () => {
  const action = vi.fn()
  const view = render(
    <SidebarMenu
      label="Actions"
      items={[{ label: "Move", items: [{ label: "Old child", action }] }]}
    >
      {null}
    </SidebarMenu>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  view.rerender(
    <SidebarMenu
      label="Actions"
      items={[
        { label: "Renamed parent", items: [{ label: "New child", action }] },
      ]}
    >
      {null}
    </SidebarMenu>,
  )
  expect(screen.queryByRole("menuitem", { name: "Old child" })).toBeNull()
  expect(screen.queryByRole("menuitem", { name: "New child" })).toBeNull()
  await user.click(screen.getByRole("menuitem", { name: "Renamed parent" }))
  expect(screen.getByRole("menuitem", { name: "New child" })).toBeDefined()
  expect(action).not.toHaveBeenCalled()
})

it("keeps keyboard dismissal available if the focused live submenu item is deleted", async () => {
  const action = vi.fn()
  const view = render(
    <SidebarMenu
      label="Actions"
      items={[
        {
          label: "Move",
          items: [
            { label: "All sessions", action },
            { label: "Deleted section", action },
          ],
        },
      ]}
    >
      {null}
    </SidebarMenu>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  screen.getByRole("menuitem", { name: "Deleted section" }).focus()
  expect(document.activeElement?.textContent).toBe("Deleted section")
  view.rerender(
    <SidebarMenu
      label="Actions"
      items={[{ label: "Move", items: [{ label: "All sessions", action }] }]}
    >
      {null}
    </SidebarMenu>,
  )
  expect(screen.queryByRole("menuitem", { name: "Deleted section" })).toBeNull()
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull(),
  )
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Actions" }),
  )
})

it("keeps keyboard dismissal available when the open submenu parent vanishes", async () => {
  const action = vi.fn()
  const view = render(
    <SidebarMenu
      label="Actions"
      items={[
        { label: "Move", items: [{ label: "Child", action }] },
        { label: "Rename", action },
      ]}
    >
      {null}
    </SidebarMenu>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  view.rerender(
    <SidebarMenu label="Actions" items={[{ label: "Rename", action }]}>
      {null}
    </SidebarMenu>,
  )
  expect(screen.queryByRole("menu", { name: "Move" })).toBeNull()
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull(),
  )
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Actions" }),
  )
})

it("does not move a still-live focused row or external control on refresh", async () => {
  const action = vi.fn()
  const user = userEvent.setup()
  const menu = (extra: boolean) => (
    <>
      <button type="button">External</button>
      <SidebarMenu
        label="Actions"
        items={[
          {
            label: "Move",
            items: [
              { label: "First", action },
              { label: "Surviving", action },
              ...(extra ? [{ label: "New", action }] : []),
            ],
          },
        ]}
      >
        {null}
      </SidebarMenu>
    </>
  )
  const view = render(menu(false))
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  const surviving = screen.getByRole("menuitem", { name: "Surviving" })
  surviving.focus()
  view.rerender(menu(true))
  expect(document.activeElement).toBe(surviving)
  const external = screen.getByRole("button", { name: "External" })
  external.focus()
  view.rerender(menu(false))
  expect(document.activeElement).toBe(external)
})
it("returns focus to a surviving parent when the live submenu becomes empty", async () => {
  const action = vi.fn()
  const user = userEvent.setup()
  const view = render(
    <SidebarMenu
      label="Actions"
      items={[{ label: "Move", items: [{ label: "Only child", action }] }]}
    >
      {null}
    </SidebarMenu>,
  )
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  view.rerender(
    <SidebarMenu label="Actions" items={[{ label: "Move", items: [] }]}>
      {null}
    </SidebarMenu>,
  )
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Move" }),
  )
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Actions" })).toBeNull(),
  )
})
it("reclamps a live submenu that gains rows near the viewport bottom", async () => {
  vi.stubGlobal("innerHeight", 300)
  vi.stubGlobal("innerWidth", 500)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height =
        this.getAttribute("role") === "menu"
          ? this.querySelectorAll("button").length * 30
          : 20
      const top = this.textContent === "Move" ? 230 : 200
      const left = 20
      const width = 150
      return {
        x: left,
        y: top,
        left,
        right: left + width,
        top,
        bottom: top + height,
        width,
        height,
        toJSON() {
          return {}
        },
      }
    },
  )
  const action = vi.fn()
  const user = userEvent.setup()
  const menu = (labels: string[]) => (
    <SidebarMenu
      label="Actions"
      items={[
        { label: "Move", items: labels.map((label) => ({ label, action })) },
      ]}
    >
      {null}
    </SidebarMenu>
  )
  const view = render(menu(["First"]))
  await user.click(screen.getByRole("button", { name: "Actions" }))
  await user.click(screen.getByRole("menuitem", { name: "Move" }))
  const panel = screen.getByRole("menu", { name: "Move" })
  expect(Number.parseFloat(panel.style.top) + 30).toBeLessThanOrEqual(292)
  view.rerender(menu(["First", "Second", "Third", "Fourth", "Fifth"]))
  expect(Number.parseFloat(panel.style.top) + 150).toBeLessThanOrEqual(292)
})
