import type { UserAttachment } from "./asset-types.ts"
import type { ContextExcerpt } from "./input-context.ts"

// JavaScript and renderer selections use UTF-16 offsets (Codex uses UTF-8 byte
// ranges). Elements mark editor atoms in one text, never model content ordering.
export type InputTextElement = Readonly<{
  startOffset: number
  endOffset: number
  attachmentIndex: number
}>

export type InputDraft = Readonly<{
  kind: "input"
  text: string
  elements: readonly InputTextElement[]
  attachments: readonly UserAttachment[]
}>

export type InputContent = Readonly<
  InputDraft & { kind: "input"; references?: readonly ContextExcerpt[] }
>
