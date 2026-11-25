import type { Locale } from "./locale.ts"
import { zhCN } from "./zh-cn.ts"

export type Message = keyof typeof zhCN
export type Translate = (
  message: Message,
  ...values: (string | number)[]
) => string

function interpolate(
  message: string,
  values: readonly (string | number)[],
): string {
  if (values.length === 0) return message
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    String(values[Number(index)] ?? placeholder),
  )
}

export const translators: Readonly<Record<Locale, Translate>> = {
  en: (message, ...values) => interpolate(message, values),
  "zh-CN": (message, ...values) => interpolate(zhCN[message], values),
}
