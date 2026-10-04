// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { LiveTextNotice } from "../../src/gui/components/cells/live-text-notice.tsx"

afterEach(cleanup)
it("distinguishes a lost connection from incomplete recovered or saved text", () => {
  const { rerender } = render(
    <LiveTextNotice entry={{ status: "suspended", incomplete: true }} />,
  )
  expect(
    screen.getByText("Live text paused. Waiting to reconnect."),
  ).toBeDefined()
  rerender(<LiveTextNotice entry={{ status: "partial", incomplete: true }} />)
  expect(screen.queryByText(/reconnect/)).toBeNull()
  expect(
    screen.getByText("Partial text. Waiting for saved output."),
  ).toBeDefined()
  rerender(<LiveTextNotice entry={{ status: "streaming", incomplete: true }} />)
  expect(
    screen.getByText(
      "Partial live text. The full response will appear when saved.",
    ),
  ).toBeDefined()
  rerender(<LiveTextNotice entry={{ status: "completed", incomplete: true }} />)
  expect(
    screen.getByText("Partial text. Some live output could not be recovered."),
  ).toBeDefined()
  rerender(<LiveTextNotice entry={{ status: "completed" }} />)
  expect(screen.queryByText(/Partial/)).toBeNull()
})
