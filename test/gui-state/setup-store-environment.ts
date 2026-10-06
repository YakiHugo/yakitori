import { beforeEach, vi } from "vitest"
import "../gui/setup-localstorage.ts"

// Store contracts need only origin selection and Storage. Leave window and
// document absent so accidentally importing a browser/UI dependency fails.
function resetLocation(): void {
  vi.stubGlobal("location", new URL("http://localhost/"))
}

resetLocation()
beforeEach(resetLocation)

if (typeof window !== "undefined" || typeof document !== "undefined") {
  throw new Error("Store contracts must run in the Node test environment.")
}
