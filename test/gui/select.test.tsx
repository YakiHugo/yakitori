import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import { Select } from "../../src/gui/components/ui/select.tsx"

afterEach(cleanup)

it("allows returning to an explicit empty choice", async () => {
  function ProjectChoice() {
    const [value, setValue] = useState("")
    return (
      <Select<string>
        aria-label="Project"
        value={value}
        onValueChange={setValue}
        options={[
          { value: "", label: "No project" },
          { value: "workspace", label: "Workspace" },
        ]}
      />
    )
  }
  const user = userEvent.setup()
  render(<ProjectChoice />)
  const trigger = screen.getByRole("combobox", { name: "Project" })
  await user.click(trigger)
  await user.click(screen.getByRole("option", { name: "Workspace" }))
  expect(trigger.textContent).toBe("Workspace")
  await user.click(trigger)
  await user.click(screen.getByRole("option", { name: "No project" }))
  expect(trigger.textContent).toBe("No project")
})

it("preserves numeric values when publishing a selection", async () => {
  function PeriodChoice() {
    const [value, setValue] = useState<number | "all">("all")
    return (
      <>
        <Select<number | "all">
          aria-label="Period"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 7, label: "Last week" },
            { value: "all", label: "All time" },
          ]}
        />
        <output>
          {typeof value}: {value}
        </output>
      </>
    )
  }
  const user = userEvent.setup()
  render(<PeriodChoice />)
  await user.click(screen.getByRole("combobox", { name: "Period" }))
  await user.click(screen.getByRole("option", { name: "Last week" }))
  expect(screen.getByRole("status").textContent).toBe("number: 7")
})
