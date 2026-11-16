// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import {
  type ChangeFileItem,
  ChangeFileTree,
} from "../../src/gui/components/change-file-tree.tsx"
import type { WorkspaceGitStats } from "../../src/protocol/workspace.ts"

afterEach(cleanup)

function file(
  path: string,
  staged = false,
  stats?: WorkspaceGitStats,
): ChangeFileItem {
  return {
    staged,
    entry: {
      path,
      indexStatus: staged ? "M" : " ",
      worktreeStatus: staged ? " " : "M",
      ...(stats
        ? staged
          ? { stagedStats: stats }
          : { unstagedStats: stats }
        : {}),
    },
  }
}

it("groups files in initially expanded directories and keeps root filenames clean", async () => {
  const user = userEvent.setup()
  const items = [
    file("README.md"),
    file("src/gui/index.ts"),
    file("src/gui/components/view.tsx"),
    file("src/gui/components/style.css"),
  ]
  const onSelect = vi.fn()
  render(
    <ChangeFileTree
      items={items}
      selectedKey={undefined}
      onSelect={onSelect}
    />,
  )
  const tree = screen.getByRole("navigation", { name: "Changed files" })
  const rootFile = within(tree).getByRole("button", {
    name: "README.md, unstaged",
  })
  expect(rootFile.textContent).toBe("README.md")
  const source = screen.getByRole("button", { name: "src/gui" })
  const components = screen.getByRole("button", { name: "components" })
  expect(source.getAttribute("aria-expanded")).toBe("true")
  expect(components.getAttribute("aria-expanded")).toBe("true")
  expect(components.textContent).toBe("components")
  const nestedFile = screen.getByRole("button", {
    name: "src/gui/components/view.tsx, unstaged",
  })
  expect(nestedFile.textContent).toBe("view.tsx")
  await user.click(nestedFile)
  expect(onSelect).toHaveBeenCalledWith(items[2])
  await user.click(components)
  expect(components.getAttribute("aria-expanded")).toBe("false")
  expect(
    screen.queryByRole("button", {
      name: "src/gui/components/view.tsx, unstaged",
    }),
  ).toBeNull()
  expect(
    screen.getByRole("button", { name: "src/gui/index.ts, unstaged" }),
  ).toBeDefined()
  await user.click(source)
  await user.click(source)
  expect(components.getAttribute("aria-expanded")).toBe("false")
})

it("preserves directory collapse when items refresh with unchanged selection", async () => {
  const user = userEvent.setup()
  const view = render(
    <ChangeFileTree
      items={[file("src/first.ts")]}
      selectedKey="unstaged:src/first.ts"
      onSelect={() => {}}
    />,
  )
  await user.click(screen.getByRole("button", { name: "src" }))
  view.rerender(
    <ChangeFileTree
      items={[file("src/first.ts"), file("src/second.ts")]}
      selectedKey="unstaged:src/first.ts"
      onSelect={() => {}}
    />,
  )
  expect(
    screen.getByRole("button", { name: "src" }).getAttribute("aria-expanded"),
  ).toBe("false")
  expect(
    screen.queryByRole("button", { name: "src/second.ts, unstaged" }),
  ).toBeNull()
  await user.click(screen.getByRole("button", { name: "src" }))
  expect(
    screen
      .getByRole("button", { name: "src/first.ts, unstaged" })
      .getAttribute("aria-current"),
  ).toBe("true")
})

it("reveals selected ancestors while preserving unrelated collapsed directories", async () => {
  const user = userEvent.setup()
  const items = [
    file("README.md"),
    file("src/index.ts"),
    file("src/nested/target.ts"),
    file("src-other/hidden.ts"),
  ]
  const view = render(
    <ChangeFileTree
      items={items}
      selectedKey="unstaged:README.md"
      onSelect={() => {}}
    />,
  )
  await user.click(screen.getByRole("button", { name: "nested" }))
  await user.click(screen.getByRole("button", { name: "src" }))
  await user.click(screen.getByRole("button", { name: "src-other" }))
  expect(
    screen.queryByRole("button", { name: "src/nested/target.ts, unstaged" }),
  ).toBeNull()

  view.rerender(
    <ChangeFileTree
      items={items}
      selectedKey="unstaged:src/nested/target.ts"
      onSelect={() => {}}
    />,
  )
  expect(
    screen
      .getByRole("button", { name: "src/nested/target.ts, unstaged" })
      .getAttribute("aria-current"),
  ).toBe("true")
  expect(
    screen.getByRole("button", { name: "src" }).getAttribute("aria-expanded"),
  ).toBe("true")
  expect(
    screen
      .getByRole("button", { name: "nested" })
      .getAttribute("aria-expanded"),
  ).toBe("true")
  expect(
    screen
      .getByRole("button", { name: "src-other" })
      .getAttribute("aria-expanded"),
  ).toBe("false")
})

it("distinguishes staged and unstaged versions and shows each side's line counts", async () => {
  const user = userEvent.setup()
  const entry = {
    path: "src/shared.ts",
    indexStatus: "M",
    worktreeStatus: "M",
    stagedStats: { additions: 12, deletions: 4, binary: false },
    unstagedStats: { additions: 3, deletions: 7, binary: false },
  }
  const staged = { entry, staged: true }
  const unstaged = { entry, staged: false }
  const onSelect = vi.fn()
  const view = render(
    <ChangeFileTree
      items={[staged, unstaged, file("single.ts", true)]}
      selectedKey="staged:src/shared.ts"
      onSelect={onSelect}
    />,
  )
  const stagedRow = screen.getByRole("button", {
    name: "src/shared.ts, staged",
  })
  const unstagedRow = screen.getByRole("button", {
    name: "src/shared.ts, unstaged",
  })
  expect(stagedRow.getAttribute("aria-current")).toBe("true")
  expect(unstagedRow.hasAttribute("aria-current")).toBe(false)
  expect(within(stagedRow).getByText("Staged")).toBeDefined()
  expect(within(stagedRow).getByText("+12")).toBeDefined()
  expect(within(stagedRow).getByText("−4")).toBeDefined()
  expect(within(unstagedRow).getByText("Unstaged")).toBeDefined()
  expect(within(unstagedRow).getByText("+3")).toBeDefined()
  expect(within(unstagedRow).getByText("−7")).toBeDefined()
  expect(
    screen.getByRole("button", { name: "single.ts, staged" }).textContent,
  ).toBe("single.ts")
  expect(screen.queryByText("Modified")).toBeNull()
  await user.click(unstagedRow)
  expect(onSelect).toHaveBeenCalledWith(unstaged)
  view.rerender(
    <ChangeFileTree
      items={[staged, unstaged]}
      selectedKey="unstaged:src/shared.ts"
      onSelect={onSelect}
    />,
  )
  expect(stagedRow.hasAttribute("aria-current")).toBe(false)
  expect(unstagedRow.getAttribute("aria-current")).toBe("true")
})

it("uses the existing binary and unavailable-stat displays", () => {
  render(
    <ChangeFileTree
      items={[
        file("image.png", false, { additions: 0, deletions: 0, binary: true }),
        file("untracked.ts"),
      ]}
      selectedKey={undefined}
      onSelect={() => {}}
    />,
  )
  const binary = screen.getByRole("button", { name: "image.png, unstaged" })
  expect(within(binary).getByText("Binary")).toBeDefined()
  expect(within(binary).queryByText("+0")).toBeNull()
  expect(
    screen.getByRole("button", { name: "untracked.ts, unstaged" }).textContent,
  ).toBe("untracked.ts")
})
