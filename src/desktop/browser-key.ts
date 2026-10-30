import type { BrowserKeyRequest } from "../protocol/desktop-browser.ts"

export function browserKeyStroke(
  key: string,
  modifiers: BrowserKeyRequest["modifiers"] = [],
): {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  location?: number
} {
  const named: Record<string, [string, number]> = {
    Enter: ["Enter", 13],
    Tab: ["Tab", 9],
    Escape: ["Escape", 27],
    Backspace: ["Backspace", 8],
    Delete: ["Delete", 46],
    Insert: ["Insert", 45],
    Home: ["Home", 36],
    End: ["End", 35],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowRight: ["ArrowRight", 39],
    ArrowDown: ["ArrowDown", 40],
    Space: ["Space", 32],
    Alt: ["AltLeft", 18],
    Control: ["ControlLeft", 17],
    Meta: ["MetaLeft", 91],
    Shift: ["ShiftLeft", 16],
  }
  const shortcut = modifiers.some((modifier) => modifier !== "Shift")
  const shift = modifiers.includes("Shift")
  if (Object.hasOwn(named, key)) {
    const entry = named[key]
    if (!entry) throw new Error("Missing named browser key")
    return {
      key: key === "Space" ? " " : key,
      code: entry[0],
      windowsVirtualKeyCode: entry[1],
      ...(["Alt", "Control", "Meta", "Shift"].includes(key)
        ? { location: 1 }
        : {}),
      ...(!shortcut && (key === "Enter" || key === "Space")
        ? { text: key === "Enter" ? "\r" : " " }
        : {}),
    }
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key))
    return { key, code: key, windowsVirtualKeyCode: 111 + Number(key.slice(1)) }
  if (/^[a-zA-Z]$/.test(key)) {
    const effective = shift ? key.toUpperCase() : key
    return {
      key: effective,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      ...(!shortcut ? { text: effective } : {}),
    }
  }
  if (/^[0-9]$/.test(key)) {
    const effective = shift ? ")!@#$%^&*("[Number(key)] : key
    if (!effective) throw new Error("Missing shifted browser digit")
    return {
      key: effective,
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
      ...(!shortcut ? { text: effective } : {}),
    }
  }
  // Physical codes for the explicitly supported printable US key names.
  // Unicode text uses browser_input type/fill instead of guessing a layout.
  const punctuation: [string, string, string, number][] = [
    [";", ":", "Semicolon", 186],
    ["=", "+", "Equal", 187],
    [",", "<", "Comma", 188],
    ["-", "_", "Minus", 189],
    [".", ">", "Period", 190],
    ["/", "?", "Slash", 191],
    ["`", "~", "Backquote", 192],
    ["[", "{", "BracketLeft", 219],
    ["\\", "|", "Backslash", 220],
    ["]", "}", "BracketRight", 221],
    ["'", '"', "Quote", 222],
    ...Array.from(
      "0123456789",
      (digit, index): [string, string, string, number] => [
        digit,
        ")!@#$%^&*(".charAt(index),
        `Digit${digit}`,
        digit.charCodeAt(0),
      ],
    ),
  ]
  const entry = punctuation.find(
    ([plain, shifted]) => key === plain || key === shifted,
  )
  if (!entry) throw new Error(`Unsupported validated browser key ${key}`)
  const effective = shift ? entry[1] : key
  return {
    key: effective,
    code: entry[2],
    windowsVirtualKeyCode: entry[3],
    ...(!shortcut ? { text: effective } : {}),
  }
}
