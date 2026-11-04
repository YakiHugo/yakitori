import { expect, it } from "vitest"
import {
  BrowserControlError,
  parseBrowserChooserRequest,
  parseBrowserDialogRequest,
  parseBrowserDownloadRequest,
  parseBrowserDragRequest,
  parseBrowserRequest,
} from "../../src/protocol/desktop-browser.ts"

const target = {
  tabId: "tab_test",
  webContentsId: 1,
  instanceId: "browser_target_00000000-0000-4000-8000-000000000001",
}

it.each([
  {
    name: "drag action",
    parse: parseBrowserDragRequest,
    input: {
      action: ["drag_drop"],
      target,
      reference: "browser_element_00000000-0000-4000-8000-000000000002",
      dragId: "browser_drag_00000000-0000-4000-8000-000000000003",
    },
  },
  {
    name: "download action",
    parse: parseBrowserDownloadRequest,
    input: {
      action: ["download_cancel"],
      target,
      downloadId: "browser_download_00000000-0000-4000-8000-000000000004",
    },
  },
  {
    name: "dialog action",
    parse: parseBrowserDialogRequest,
    input: { action: ["dialog_disarm"], target },
  },
  {
    name: "chooser action",
    parse: parseBrowserChooserRequest,
    input: { action: ["chooser_disarm"], target },
  },
  {
    name: "dialog response type",
    parse: parseBrowserDialogRequest,
    input: {
      action: "dialog_arm",
      target,
      fromUrl: "https://example.test/",
      response: { type: ["confirm"], accept: true },
    },
  },
])("rejects an array used as a $name", ({ parse, input }) => {
  expect(() => parse(input)).toThrow(BrowserControlError)
  expect(() => parseBrowserRequest(input)).toThrow(BrowserControlError)
})
