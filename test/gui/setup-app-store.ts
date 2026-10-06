import { beforeEach } from "vitest"
import type { AppStore } from "../../src/gui/store/app-store.ts"

// UI tests share the renderer singleton and can replace its actions. The
// Node store contracts install their own storage/location harness and reset
// their stores explicitly, so only apply this implicit reset in the DOM lane.
if (typeof window !== "undefined") {
  // zustand setState is a shallow merge and createInitialAppState() returns
  // only data fields, so action mocks a test installs stay in the shared
  // store and leak into later tests. Capture the real actions on the first
  // reset (lazily, so the test file's own imports and vi.mock registrations
  // have already settled) and restore them with the data before every test.
  let realActions: Partial<AppStore> | undefined

  beforeEach(async () => {
    const { createInitialAppState, useAppStore } = await import(
      "../../src/gui/store/app-store.ts"
    )
    if (realActions === undefined) {
      realActions = Object.fromEntries(
        Object.entries(useAppStore.getState()).filter(
          ([, value]) => typeof value === "function",
        ),
      ) as Partial<AppStore>
    }
    useAppStore.setState({ ...createInitialAppState(), ...realActions })
  })
}
