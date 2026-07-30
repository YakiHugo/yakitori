// Node 24 exposes a built-in global localStorage stub that shadows the DOM
// Storage in test environments (its methods are missing without a valid
// --localstorage-file path). Replace it with an in-memory Storage so GUI
// tests exercise the real browser code paths.
const store = new Map<string, string>()

const memoryStorage: Storage = {
  get length() {
    return store.size
  },
  clear() {
    store.clear()
  },
  getItem(key: string) {
    return store.get(key) ?? null
  },
  key(index: number) {
    return Array.from(store.keys()).at(index) ?? null
  },
  removeItem(key: string) {
    store.delete(key)
  },
  setItem(key: string, value: string) {
    store.set(key, value)
  },
}

Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
  writable: true,
})
