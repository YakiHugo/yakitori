// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { LiveTextNotice } from "../../src/gui/components/cells/live-text-notice.tsx"

afterEach(cleanup)
it("distinguishes a lost connection from incomplete recovered or saved text", () => {
  const { container, rerender } = render(
    <LiveTextNotice entry={{ status: "suspended", incomplete: true }} />,
  )
  expect(screen.getByText(/waiting to reconnect/i)).toBeDefined()
  expect(screen.queryByText(/saved/i)).toBeNull()
  rerender(<LiveTextNotice entry={{ status: "partial", incomplete: true }} />)
  expect(screen.queryByText(/reconnect/)).toBeNull()
  expect(screen.getByText(/partial.*waiting for saved output/i)).toBeDefined()
  rerender(<LiveTextNotice entry={{ status: "completed", incomplete: true }} />)
  expect(screen.getByText(/partial/i)).toBeDefined()
  expect(screen.queryByText(/waiting|reconnect/i)).toBeNull()
  rerender(<LiveTextNotice entry={{ status: "completed" }} />)
  expect(container.firstChild).toBeNull()
})
