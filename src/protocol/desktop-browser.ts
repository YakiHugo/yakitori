import type { JsonObject } from "./events.ts"
import { isJsonObject } from "./json.ts"

export type BrowserTarget = Readonly<{
  tabId: string
  webContentsId: number
  instanceId: string
}>
export type BrowserObservationRequest =
  | Readonly<{ action: "list"; offset?: number }>
  | Readonly<{ action: "frames"; target: BrowserTarget; offset?: number }>
  | Readonly<{
      action: "observe"
      target: BrowserTarget
      frameReference?: string
    }>

export type BrowserTextInputRequest = Readonly<{
  action: "type" | "fill"
  target: BrowserTarget
  reference: string
  text: string
}>

export type BrowserPointerRequest = Readonly<
  { target: BrowserTarget; reference: string } & (
    | {
        action: "click"
        button?: "left" | "middle" | "right"
        clickCount?: 1 | 2
      }
    | { action: "hover" }
    | { action: "scroll"; deltaX: number; deltaY: number }
  )
>
export type BrowserInputRequest =
  | BrowserTextInputRequest
  | BrowserPointerRequest
  | BrowserKeyRequest
  | BrowserSelectRequest

export type BrowserSelectRequest = Readonly<{
  action: "select"
  target: BrowserTarget
  reference: string
  options: ({ value: string } | { label: string } | { index: number })[]
}>

export const browserNamedKeys = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
] as const
export type BrowserKeyRequest = Readonly<{
  action: "press"
  target: BrowserTarget
  reference: string
  key: string
  modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[]
}>

export function parseBrowserInputRequest(value: unknown): BrowserInputRequest {
  if (
    isJsonObject(value) &&
    value.action === "select" &&
    Object.keys(value).length === 4 &&
    ["action", "target", "reference", "options"].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    typeof value.reference === "string" &&
    /^browser_element_[a-f0-9-]{36}$/.test(value.reference) &&
    Array.isArray(value.options) &&
    value.options.length <= 256 &&
    Buffer.byteLength(JSON.stringify(value.options)) <= 64 * 1024 &&
    value.options.every(
      (option) =>
        isJsonObject(option) &&
        Object.keys(option).length === 1 &&
        (typeof option.value === "string" ||
          typeof option.label === "string" ||
          (typeof option.index === "number" &&
            Number.isSafeInteger(option.index) &&
            option.index >= 0)),
    )
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: "select",
      target: observed.target,
      reference: value.reference,
      options: value.options as BrowserSelectRequest["options"],
    }
  }
  if (
    isJsonObject(value) &&
    ["action", "target", "reference"].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    Object.keys(value).every((key) =>
      [
        "action",
        "target",
        "reference",
        "button",
        "clickCount",
        "deltaX",
        "deltaY",
      ].includes(key),
    ) &&
    typeof value.reference === "string" &&
    /^browser_element_[a-f0-9-]{36}$/.test(value.reference)
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    const shared = { target: observed.target, reference: value.reference }
    if (value.action === "hover" && Object.keys(value).length === 3)
      return { action: "hover", ...shared }
    if (
      value.action === "click" &&
      !Object.hasOwn(value, "deltaX") &&
      !Object.hasOwn(value, "deltaY") &&
      (value.button === undefined ||
        value.button === "left" ||
        value.button === "middle" ||
        value.button === "right") &&
      (value.clickCount === undefined ||
        value.clickCount === 1 ||
        value.clickCount === 2)
    )
      return {
        action: "click",
        ...shared,
        ...(value.button === undefined ? {} : { button: value.button }),
        ...(value.clickCount === undefined
          ? {}
          : { clickCount: value.clickCount }),
      }
    if (
      value.action === "scroll" &&
      Object.keys(value).length === 5 &&
      typeof value.deltaX === "number" &&
      Number.isFinite(value.deltaX) &&
      Math.abs(value.deltaX) <= 10000 &&
      typeof value.deltaY === "number" &&
      Number.isFinite(value.deltaY) &&
      Math.abs(value.deltaY) <= 10000 &&
      (value.deltaX !== 0 || value.deltaY !== 0)
    )
      return {
        action: "scroll",
        ...shared,
        deltaX: value.deltaX,
        deltaY: value.deltaY,
      }
  }
  if (
    isJsonObject(value) &&
    value.action === "press" &&
    ["action", "target", "reference", "key"].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    Object.keys(value).every((key) =>
      ["action", "target", "reference", "key", "modifiers"].includes(key),
    ) &&
    typeof value.reference === "string" &&
    /^browser_element_[a-f0-9-]{36}$/.test(value.reference) &&
    typeof value.key === "string" &&
    (/^[!-~]$/.test(value.key) ||
      /^F([1-9]|1[0-9]|2[0-4])$/.test(value.key) ||
      browserNamedKeys.some((key) => key === value.key)) &&
    (value.modifiers === undefined ||
      (Array.isArray(value.modifiers) &&
        value.modifiers.length <= 4 &&
        new Set(value.modifiers).size === value.modifiers.length &&
        value.modifiers.every(
          (key) =>
            typeof key === "string" &&
            ["Alt", "Control", "Meta", "Shift"].includes(key),
        )))
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: "press",
      target: observed.target,
      reference: value.reference,
      key: value.key,
      ...(value.modifiers === undefined
        ? {}
        : {
            modifiers: value.modifiers as NonNullable<
              BrowserKeyRequest["modifiers"]
            >,
          }),
    }
  }
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
      ["action", "target", "reference", "text"].includes(key),
    ) &&
    (value.action === "type" || value.action === "fill") &&
    typeof value.reference === "string" &&
    /^browser_node_[a-f0-9-]{36}$/.test(value.reference) &&
    typeof value.text === "string" &&
    (value.text.length > 0 || value.action === "fill") &&
    Buffer.byteLength(value.text) <= 64 * 1024
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: value.action,
      target: observed.target,
      reference: value.reference,
      text: value.text,
    }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use type/fill with an inputReference and text, or click/hover/scroll/press/select with an elementReference and exact target. Select requires options, each with exactly one value, label or nonnegative index; an empty array clears selection (256-descriptor and 64KiB per-action safety bounds). Press requires key (printable ASCII, F1–F24 or a documented named key), with optional distinct Alt/Control/Meta/Shift modifiers. Click accepts left/middle/right button and clickCount 1/2; scroll requires finite deltaX/deltaY, at least one nonzero (10000 CSS-pixel per-axis event safety bound). Only fill permits empty text (64KiB input-event safety bound).",
  )
}

export type BrowserNavigationRequest = Readonly<{
  action: "navigate"
  target: BrowserTarget
  fromUrl: string
  url: string
}>

export function parseBrowserNavigationRequest(
  value: unknown,
): BrowserNavigationRequest {
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) =>
      ["action", "target", "fromUrl", "url"].includes(key),
    ) &&
    value.action === "navigate" &&
    typeof value.fromUrl === "string" &&
    value.fromUrl.length <= 8192 &&
    typeof value.url === "string" &&
    value.url.length <= 8192 &&
    URL.canParse(value.url)
  ) {
    const url = new URL(value.url)
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    ) {
      const observed = parseBrowserObservationRequest({
        action: "observe",
        target: value.target,
      })
      if (observed.action !== "observe")
        throw new Error("Invalid browser target parser result.")
      return {
        action: "navigate",
        target: observed.target,
        fromUrl: value.fromUrl,
        url: url.href,
      }
    }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use navigate with an exact listed target, its current fromUrl and an absolute HTTP(S) destination without credentials (8192-character URL safety bound).",
  )
}

export type BrowserCaptureRequest = Readonly<
  { action: "capture"; target: BrowserTarget } & (
    | { mode: "viewport" | "page" }
    | {
        mode: "clip"
        clip: { x: number; y: number; width: number; height: number }
      }
  )
>

export function parseBrowserCaptureRequest(
  value: unknown,
): BrowserCaptureRequest {
  if (
    isJsonObject(value) &&
    value.action === "capture" &&
    ["action", "target", "mode"].every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) =>
      ["action", "target", "mode", "clip"].includes(key),
    )
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    if (
      (value.mode === "viewport" || value.mode === "page") &&
      Object.keys(value).length === 3
    )
      return { action: "capture", target: observed.target, mode: value.mode }
    const clip = value.clip
    if (
      value.mode === "clip" &&
      isJsonObject(clip) &&
      Object.keys(clip).length === 4 &&
      ["x", "y", "width", "height"].every((key) => Object.hasOwn(clip, key)) &&
      typeof clip.x === "number" &&
      typeof clip.y === "number" &&
      typeof clip.width === "number" &&
      typeof clip.height === "number" &&
      clip.x >= 0 &&
      clip.y >= 0 &&
      clip.width > 0 &&
      clip.height > 0 &&
      clip.width * clip.height <= 16_000_000
    )
      return {
        action: "capture",
        target: observed.target,
        mode: "clip",
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
      }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use capture with an exact target and mode viewport/page, or mode clip with a positive document CSS-pixel rectangle (16 megapixel source paint safety bound).",
  )
}

export type BrowserRequest =
  | BrowserObservationRequest
  | BrowserInputRequest
  | BrowserNavigationRequest
  | BrowserCaptureRequest
  | BrowserUploadRequest
  | BrowserDirectoryUploadRequest
  | BrowserViewRequest
  | BrowserChooserRequest
  | BrowserDialogRequest

export type BrowserUploadRequest = Readonly<{
  action: "upload"
  target: BrowserTarget
  reference: string
  fromUrl: string
  files: Readonly<{
    path: string
    name: string
    size: number
    lastModified: number
  }>[]
}>

export function parseBrowserUploadRequest(
  value: unknown,
): BrowserUploadRequest {
  if (
    isJsonObject(value) &&
    value.action === "upload" &&
    Object.keys(value).length === 5 &&
    ["action", "target", "reference", "fromUrl", "files"].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    typeof value.reference === "string" &&
    /^browser_element_[a-f0-9-]{36}$/.test(value.reference) &&
    typeof value.fromUrl === "string" &&
    value.fromUrl.length > 0 &&
    value.fromUrl.length <= 8192 &&
    Array.isArray(value.files) &&
    value.files.length <= 256 &&
    Buffer.byteLength(JSON.stringify(value.files)) <= 128 * 1024 &&
    value.files.every(
      (file) =>
        isJsonObject(file) &&
        Object.keys(file).length === 4 &&
        typeof file.path === "string" &&
        file.path.startsWith("/") &&
        !file.path.includes("\0") &&
        file.path.length <= 8192 &&
        typeof file.name === "string" &&
        file.name.length > 0 &&
        file.name.length <= 4096 &&
        !file.name.includes("/") &&
        !file.name.includes("\0") &&
        typeof file.size === "number" &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        typeof file.lastModified === "number" &&
        Number.isSafeInteger(file.lastModified),
    )
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: value.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: "upload",
      target: observed.target,
      reference: value.reference,
      fromUrl: value.fromUrl,
      files: value.files as BrowserUploadRequest["files"],
    }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use upload with an exact elementReference and observed document fromUrl. Desktop transport accepts up to 256 canonical macOS regular-file metadata records (128KiB transport safety bound).",
  )
}

export type BrowserDirectoryUploadRequest = Readonly<{
  action: "upload_directory"
  target: BrowserTarget
  reference: string
  fromUrl: string
  directory: string
  files: Readonly<{
    name: string
    size: number
    lastModified: number
    relativePath: string
  }>[]
}>

export function parseBrowserDirectoryUploadRequest(
  value: unknown,
): BrowserDirectoryUploadRequest {
  if (
    !isJsonObject(value) ||
    value.action !== "upload_directory" ||
    Object.keys(value).length !== 6 ||
    !["action", "target", "reference", "fromUrl", "directory", "files"].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    typeof value.directory !== "string" ||
    !value.directory.startsWith("/") ||
    value.directory.length > 8192 ||
    value.directory.includes("\0") ||
    !Array.isArray(value.files) ||
    value.files.length > 256 ||
    Buffer.byteLength(JSON.stringify(value.files)) > 65536 ||
    !value.files.every(
      (file) =>
        isJsonObject(file) &&
        Object.keys(file).length === 4 &&
        typeof file.name === "string" &&
        file.name.length > 0 &&
        file.name.length <= 4096 &&
        !file.name.includes("/") &&
        !file.name.includes("\0") &&
        typeof file.size === "number" &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        typeof file.lastModified === "number" &&
        Number.isSafeInteger(file.lastModified) &&
        typeof file.relativePath === "string" &&
        file.relativePath.length <= 8192 &&
        !file.relativePath.includes("\0") &&
        file.relativePath.split("/").length >= 2 &&
        file.relativePath
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== "..") &&
        file.relativePath.split("/").at(-1) === file.name &&
        file.relativePath.split("/")[0] ===
          (typeof value.directory === "string"
            ? value.directory.split("/").at(-1)
            : undefined),
    ) ||
    new Set(
      value.files.map((file) =>
        isJsonObject(file) ? file.relativePath : undefined,
      ),
    ).size !== value.files.length
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use upload_directory with a canonical macOS directory and bounded regular-file metadata (256 files, 64KiB metadata). Relative paths must include the selected folder name.",
    )
  const base = parseBrowserUploadRequest({
    action: "upload",
    target: value.target,
    reference: value.reference,
    fromUrl: value.fromUrl,
    files: [],
  })
  return {
    action: "upload_directory",
    target: base.target,
    reference: base.reference,
    fromUrl: base.fromUrl,
    directory: value.directory,
    files: value.files as BrowserDirectoryUploadRequest["files"],
  }
}

export type BrowserDialogRule = Readonly<{
  type: "alert" | "confirm" | "beforeunload" | "prompt"
  accept: boolean
  message?: string
  promptText?: string
}>
export type BrowserDialogRequest =
  | Readonly<{
      action: "dialog_arm"
      target: BrowserTarget
      fromUrl: string
      frameReference?: string
      response: BrowserDialogRule
    }>
  | Readonly<{
      action: "dialog_inspect" | "dialog_disarm"
      target: BrowserTarget
    }>

export function parseBrowserDialogRequest(
  value: unknown,
): BrowserDialogRequest {
  if (
    !isJsonObject(value) ||
    !["dialog_arm", "dialog_inspect", "dialog_disarm"].includes(
      String(value.action),
    )
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use an exact target and a JavaScript dialog action.",
    )
  const arm = value.action === "dialog_arm",
    response = value.response
  if (
    arm &&
    (!isJsonObject(response) ||
      Object.keys(response).some(
        (key) => !["type", "accept", "message", "promptText"].includes(key),
      ) ||
      !["alert", "confirm", "beforeunload", "prompt"].includes(
        String(response.type),
      ) ||
      typeof response.accept !== "boolean" ||
      (response.type === "alert" && !response.accept) ||
      (Object.hasOwn(response, "promptText") &&
        (response.type !== "prompt" ||
          !response.accept ||
          typeof response.promptText !== "string" ||
          Buffer.byteLength(response.promptText) > 8192)) ||
      (response.message !== undefined &&
        (typeof response.message !== "string" ||
          Buffer.byteLength(response.message) > 8192)))
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Arm with one response: alert (accept true), confirm, beforeunload or prompt, an explicit accept boolean and optional exact message. Only an accepted prompt allows promptText (8KiB text safety bounds).",
    )
  if (
    Object.keys(value).some(
      (key) =>
        !(
          arm
            ? ["action", "target", "fromUrl", "frameReference", "response"]
            : ["action", "target"]
        ).includes(key),
    ) ||
    (arm &&
      (typeof value.fromUrl !== "string" ||
        !value.fromUrl.length ||
        value.fromUrl.length > 8192))
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Arm requires the observed fromUrl, optional frameReference and response; inspect/disarm accept only a target.",
    )
  const observed = parseBrowserObservationRequest({
    action: "observe",
    target: value.target,
    ...(arm && value.frameReference !== undefined
      ? { frameReference: value.frameReference }
      : {}),
  })
  if (observed.action !== "observe")
    throw new Error("Invalid dialog target parser result.")
  if (arm)
    return {
      action: "dialog_arm",
      target: observed.target,
      fromUrl: value.fromUrl as string,
      ...(observed.frameReference
        ? { frameReference: observed.frameReference }
        : {}),
      response: response as BrowserDialogRule,
    }
  return {
    action: value.action as "dialog_inspect" | "dialog_disarm",
    target: observed.target,
  }
}

export type BrowserChooserRequest =
  | Readonly<{
      action: "chooser_arm"
      target: BrowserTarget
      fromUrl: string
      frameReference?: string
    }>
  | Readonly<{
      action: "chooser_inspect" | "chooser_disarm"
      target: BrowserTarget
    }>

export function parseBrowserChooserRequest(
  value: unknown,
): BrowserChooserRequest {
  if (
    !isJsonObject(value) ||
    !["chooser_arm", "chooser_inspect", "chooser_disarm"].includes(
      String(value.action),
    )
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use an exact target and a file chooser action.",
    )
  const arm = value.action === "chooser_arm"
  if (
    Object.keys(value).some(
      (key) =>
        !(
          arm
            ? ["action", "target", "fromUrl", "frameReference"]
            : ["action", "target"]
        ).includes(key),
    ) ||
    (arm &&
      (typeof value.fromUrl !== "string" ||
        !value.fromUrl.length ||
        value.fromUrl.length > 8192))
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Arming requires the observed document URL and optional current frameReference; inspect/disarm accept only a target.",
    )
  const observed = parseBrowserObservationRequest({
    action: "observe",
    target: value.target,
    ...(arm && value.frameReference !== undefined
      ? { frameReference: value.frameReference }
      : {}),
  })
  if (observed.action !== "observe")
    throw new Error("Invalid chooser target parser result.")
  if (arm)
    return {
      action: "chooser_arm",
      target: observed.target,
      fromUrl: value.fromUrl as string,
      ...(observed.frameReference
        ? { frameReference: observed.frameReference }
        : {}),
    }
  return {
    action: value.action as "chooser_inspect" | "chooser_disarm",
    target: observed.target,
  }
}

export type BrowserViewRequest = Readonly<{
  action: "show"
  target: BrowserTarget
  fromUrl: string
}>

export function parseBrowserViewRequest(value: unknown): BrowserViewRequest {
  if (
    !isJsonObject(value) ||
    value.action !== "show" ||
    Object.keys(value).length !== 3 ||
    !["action", "target", "fromUrl"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    typeof value.fromUrl !== "string" ||
    value.fromUrl.length > 8192
  )
    throw new BrowserControlError(
      "invalid_arguments",
      "Use show with an exact target and its current fromUrl from browser list.",
    )
  const observed = parseBrowserObservationRequest({
    action: "observe",
    target: value.target,
  })
  if (observed.action !== "observe")
    throw new Error("Invalid browser target parser result.")
  return { action: "show", target: observed.target, fromUrl: value.fromUrl }
}

const requestMutates: Record<BrowserRequest["action"], boolean> = {
  list: false,
  observe: false,
  frames: false,
  capture: false,
  type: true,
  fill: true,
  click: true,
  hover: true,
  scroll: true,
  press: true,
  select: true,
  navigate: true,
  upload: true,
  upload_directory: true,
  show: true,
  chooser_arm: true,
  chooser_inspect: false,
  chooser_disarm: true,
  dialog_arm: true,
  dialog_inspect: false,
  dialog_disarm: true,
}

export function browserRequestMutates(input: BrowserRequest): boolean {
  return requestMutates[input.action]
}

export function parseBrowserRequest(value: unknown): BrowserRequest {
  if (
    isJsonObject(value) &&
    ["dialog_arm", "dialog_inspect", "dialog_disarm"].includes(
      String(value.action),
    )
  )
    return parseBrowserDialogRequest(value)
  if (
    isJsonObject(value) &&
    ["chooser_arm", "chooser_inspect", "chooser_disarm"].includes(
      String(value.action),
    )
  )
    return parseBrowserChooserRequest(value)
  if (isJsonObject(value) && value.action === "show")
    return parseBrowserViewRequest(value)
  if (isJsonObject(value) && value.action === "upload_directory")
    return parseBrowserDirectoryUploadRequest(value)
  if (isJsonObject(value) && value.action === "upload")
    return parseBrowserUploadRequest(value)
  if (isJsonObject(value) && value.action === "capture")
    return parseBrowserCaptureRequest(value)
  if (isJsonObject(value) && value.action === "navigate")
    return parseBrowserNavigationRequest(value)
  return isJsonObject(value) &&
    (value.action === "type" ||
      value.action === "fill" ||
      value.action === "click" ||
      value.action === "hover" ||
      value.action === "scroll" ||
      value.action === "press" ||
      value.action === "select")
    ? parseBrowserInputRequest(value)
    : parseBrowserObservationRequest(value)
}

export class BrowserControlError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export function parseBrowserObservationRequest(
  value: unknown,
): BrowserObservationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BrowserControlError(
      "invalid_arguments",
      "Browser control requires an object.",
    )
  const input = value as Record<string, unknown>
  if (!Object.hasOwn(input, "action"))
    throw new BrowserControlError(
      "invalid_arguments",
      "Browser action must be an own field.",
    )
  if (
    input.action === "list" &&
    Object.keys(input).every((key) => key === "action" || key === "offset") &&
    (input.offset === undefined ||
      (typeof input.offset === "number" &&
        Number.isSafeInteger(input.offset) &&
        input.offset >= 0))
  )
    return {
      action: "list",
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    }
  if (
    input.action === "frames" &&
    ["action", "target"].every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) =>
      ["action", "target", "offset"].includes(key),
    ) &&
    (input.offset === undefined ||
      (typeof input.offset === "number" &&
        Number.isSafeInteger(input.offset) &&
        input.offset >= 0))
  ) {
    const observed = parseBrowserObservationRequest({
      action: "observe",
      target: input.target,
    })
    if (observed.action !== "observe")
      throw new Error("Invalid browser target parser result.")
    return {
      action: "frames",
      target: observed.target,
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    }
  }
  if (
    input.action === "observe" &&
    ["action", "target"].every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) =>
      ["action", "target", "frameReference"].includes(key),
    ) &&
    (input.frameReference === undefined ||
      (typeof input.frameReference === "string" &&
        /^browser_frame_[a-f0-9-]{36}$/.test(input.frameReference))) &&
    typeof input.target === "object" &&
    input.target !== null &&
    !Array.isArray(input.target)
  ) {
    const target = input.target as Record<string, unknown>
    if (
      Object.keys(target).length === 3 &&
      Object.keys(target).every((key) =>
        ["tabId", "webContentsId", "instanceId"].includes(key),
      ) &&
      typeof target.tabId === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/.test(target.tabId) &&
      typeof target.webContentsId === "number" &&
      Number.isSafeInteger(target.webContentsId) &&
      target.webContentsId > 0 &&
      typeof target.instanceId === "string" &&
      /^browser_target_[a-f0-9-]{36}$/.test(target.instanceId)
    )
      return {
        action: "observe",
        target: {
          tabId: target.tabId,
          webContentsId: target.webContentsId,
          instanceId: target.instanceId,
        },
        ...(typeof input.frameReference === "string"
          ? { frameReference: input.frameReference }
          : {}),
      }
  }
  throw new BrowserControlError(
    "invalid_arguments",
    "Use list; frames with an exact listed target and optional offset; or observe with that target and an optional issued frameReference. Extra fields are not accepted.",
  )
}

export type BrowserOwner = Readonly<{ sessionId: string; turnId: string }>

export function parseBrowserOwner(value: unknown): BrowserOwner {
  if (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every(
      (key) => key === "sessionId" || key === "turnId",
    ) &&
    typeof value.sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId) &&
    typeof value.turnId === "string" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(value.turnId)
  )
    return { sessionId: value.sessionId, turnId: value.turnId }
  throw new BrowserControlError(
    "invalid_arguments",
    "Browser operations require an owning session and turn.",
  )
}

export type BrowserOperation = Readonly<
  | {
      operation: "request"
      owner: BrowserOwner
      input: BrowserRequest
    }
  | { operation: "finishTurn"; owner: BrowserOwner }
  | { operation: "closeSession"; sessionId: string }
>
export type DesktopBrowserRequest = Readonly<{
  type: "desktop_browser/request"
  requestId: string
}> &
  BrowserOperation
export type DesktopBrowserCancellation = Readonly<{
  type: "desktop_browser/cancel"
  requestId: string
}>
export type DesktopBrowserResponse = Readonly<
  {
    type: "desktop_browser/response"
    requestId: string
  } & (
    | { ok: true; result: JsonObject }
    | { ok: false; code: string; error: string }
  )
>

export function isDesktopBrowserResponse(
  value: unknown,
): value is DesktopBrowserResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "desktop_browser/response" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("ok" in value)
  )
    return false
  return value.ok === true
    ? "result" in value && isJsonObject(value.result)
    : value.ok === false &&
        "code" in value &&
        typeof value.code === "string" &&
        "error" in value &&
        typeof value.error === "string"
}

export type DesktopBrowser = Readonly<{
  request(
    input: BrowserRequest,
    owner: BrowserOwner,
    signal?: AbortSignal,
  ): Promise<JsonObject>
  finishTurn(owner: BrowserOwner): Promise<void>
  closeSession(sessionId: string): Promise<void>
}>
