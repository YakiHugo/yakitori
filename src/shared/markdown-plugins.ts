import remarkCjkFriendly from "remark-cjk-friendly"
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import type { PluggableList } from "unified"
import { createCjkAutolinkPlugin } from "./cjk-autolink.ts"
import { createLatexMathPlugin } from "./latex-math.ts"

export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkMath,
  createLatexMathPlugin(),
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  createCjkAutolinkPlugin(),
]
