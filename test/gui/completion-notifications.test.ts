// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getNotificationPermission,
  sendTestNotification,
  startCompletionNotifications,
} from "../../src/gui/completion-notifications.ts"
import {
  defaultPreferences,
  usePreferencesStore,
} from "../../src/gui/store/preferences-store.ts"
import { FakeRpcClient } from "./fake-rpc-client.ts"

class BrowserNotification {
  static permission: NotificationPermission = "granted"
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => {
      BrowserNotification.permission = "granted"
      return "granted"
    },
  )
  static shown: BrowserNotification[] = []
  onclick: (() => void) | undefined
  close = vi.fn()

  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    BrowserNotification.shown.push(this)
  }
}

let client: FakeRpcClient
const completion = {
  sessionId: "background-session",
  turnId: "turn_1",
  title: "Finished task",
}

beforeEach(() => {
  client = new FakeRpcClient()
  usePreferencesStore.setState(defaultPreferences)
  BrowserNotification.permission = "granted"
  BrowserNotification.shown = []
  BrowserNotification.requestPermission.mockClear()
  vi.stubGlobal("Notification", BrowserNotification)
  vi.stubGlobal("yakitoriDesktop", undefined)
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
})

afterEach(() => {
  usePreferencesStore.setState(defaultPreferences)
  vi.unstubAllGlobals()
})

describe("live completion notifications", () => {
  it("consumes focused completions and only notifies about new work after losing focus", () => {
    const stop = startCompletionNotifications(client, "http://api.test")
    client.emitCompletion(completion)
    expect(BrowserNotification.shown).toHaveLength(0)

    vi.mocked(document.hasFocus).mockReturnValue(false)
    client.emitCompletion(completion)
    expect(BrowserNotification.shown).toHaveLength(0)
    client.emitCompletion({ ...completion, turnId: "turn_2" })
    expect(BrowserNotification.shown).toHaveLength(1)
    expect(BrowserNotification.shown[0]).toMatchObject({
      title: "Yakitori — task complete",
      options: { body: "Finished task", silent: false },
    })

    const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
    BrowserNotification.shown[0]?.onclick?.()
    expect(focus).toHaveBeenCalledOnce()
    expect(BrowserNotification.shown[0]?.close).toHaveBeenCalledOnce()
    stop()
  })

  it("allows hidden documents and reads current notification settings for each new completion", () => {
    const stop = startCompletionNotifications(client, "http://api.test")
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    client.emitCompletion(completion)
    expect(BrowserNotification.shown).toHaveLength(1)

    usePreferencesStore.setState({ notificationMode: "off" })
    client.emitCompletion({ ...completion, turnId: "turn_2" })
    usePreferencesStore.setState({
      notificationMode: "always",
      notificationSound: false,
    })
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    client.emitCompletion({ ...completion, turnId: "turn_2" })
    expect(BrowserNotification.shown).toHaveLength(1)

    client.emitCompletion({ ...completion, turnId: "turn_3", title: " " })
    expect(BrowserNotification.shown).toHaveLength(2)
    expect(BrowserNotification.shown[1]?.options).toEqual({
      body: "Your task has finished.",
      silent: true,
      tag: 'yakitori:["http://api.test","background-session","turn_3"]',
    })
    stop()
  })

  it("deduplicates by session and turn across listener restarts and unsubscribes on cleanup", () => {
    usePreferencesStore.setState({ notificationMode: "always" })
    const stop = startCompletionNotifications(client, "http://api.test")
    client.emitCompletion(completion)
    client.emitCompletion(completion)
    stop()
    client.emitCompletion({ ...completion, turnId: "after-stop" })
    expect(BrowserNotification.shown).toHaveLength(1)

    const stopAgain = startCompletionNotifications(client, "http://api.test")
    client.emitCompletion(completion)
    expect(BrowserNotification.shown).toHaveLength(1)
    client.emitCompletion({ ...completion, sessionId: "other-session" })
    expect(BrowserNotification.shown).toHaveLength(2)
    stopAgain()
  })

  it("never prompts for live completions or replays them after an explicit permission grant", async () => {
    BrowserNotification.permission = "default"
    usePreferencesStore.setState({ notificationMode: "always" })
    const stop = startCompletionNotifications(client, "http://api.test")
    client.emitCompletion(completion)
    expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
    expect(BrowserNotification.shown).toHaveLength(0)

    expect(await getNotificationPermission()).toBe("default")
    expect(await sendTestNotification()).toBe("sent")
    expect(BrowserNotification.requestPermission).toHaveBeenCalledOnce()
    expect(BrowserNotification.shown[0]?.title).toBe(
      "Yakitori — test notification",
    )
    client.emitCompletion(completion)
    expect(BrowserNotification.shown).toHaveLength(1)
    client.emitCompletion({ ...completion, turnId: "turn_2" })
    expect(BrowserNotification.shown).toHaveLength(2)
    stop()
  })

  it("delegates focus and sound handling to the desktop bridge", async () => {
    const show = vi.fn(async () => "sent" as const)
    const permission = vi.fn(async () => "granted" as const)
    vi.stubGlobal("yakitoriDesktop", { notifications: { show, permission } })
    usePreferencesStore.setState({ notificationSound: false })
    const stop = startCompletionNotifications(client, "http://api.test")

    client.emitCompletion(completion)
    expect(show).toHaveBeenCalledExactlyOnceWith({
      title: "Yakitori — task complete",
      body: "Finished task",
      mode: "unfocused",
      sound: false,
    })
    expect(BrowserNotification.shown).toHaveLength(0)
    expect(await getNotificationPermission()).toBe("granted")
    expect(await sendTestNotification()).toBe("sent")
    expect(show).toHaveBeenLastCalledWith({
      title: "Yakitori — test notification",
      body: "You'll be notified when a task finishes.",
      mode: "always",
      sound: false,
    })
    expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
    stop()
  })

  it("reports denied and unsupported browser notification permissions without prompting again", async () => {
    BrowserNotification.permission = "denied"
    expect(await sendTestNotification()).toBe("denied")
    expect(BrowserNotification.requestPermission).not.toHaveBeenCalled()
    expect(BrowserNotification.shown).toHaveLength(0)

    vi.stubGlobal("Notification", undefined)
    expect(await getNotificationPermission()).toBe("unsupported")
    expect(await sendTestNotification()).toBe("unsupported")
  })

  it("uses an origin-scoped browser replacement tag across clients without renotifying", () => {
    usePreferencesStore.setState({ notificationMode: "always" })
    const second = new FakeRpcClient()
    const anotherServer = new FakeRpcClient()
    const stop = startCompletionNotifications(client, "http://api.test")
    const stopSecond = startCompletionNotifications(second, "http://api.test/")
    const stopOther = startCompletionNotifications(
      anotherServer,
      "http://other.test",
    )
    client.emitCompletion(completion)
    second.emitCompletion(completion)
    anotherServer.emitCompletion(completion)
    expect(
      BrowserNotification.shown.map((notification) => notification.options.tag),
    ).toEqual([
      'yakitori:["http://api.test","background-session","turn_1"]',
      'yakitori:["http://api.test","background-session","turn_1"]',
      'yakitori:["http://other.test","background-session","turn_1"]',
    ])
    expect(
      BrowserNotification.shown.every(
        (notification) => !("renotify" in notification.options),
      ),
    ).toBe(true)
    stop()
    stopSecond()
    stopOther()
  })
})
