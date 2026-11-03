import type { Root } from "mdast"
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown"
import type {
  Construct,
  Extension,
  State,
  Tokenizer,
} from "micromark-util-types"
import type { Plugin } from "unified"

const tokenize: Tokenizer = function (effects, ok, nok) {
  const flow = this.currentConstruct?.name === "latexMathFlow"
  let closing: number
  let hasContent = false
  return start

  function consume(code: number): void {
    const type = code < -2 ? "lineEnding" : "latexMathData"
    effects.enter(type)
    effects.consume(code)
    effects.exit(type)
  }

  function start(code: number | null): State | undefined {
    if (code !== 92) return nok(code)
    effects.enter("latexMath")
    consume(code)
    return opener
  }

  function opener(code: number | null): State | undefined {
    if (code !== 91 && (flow || code !== 40)) return nok(code)
    closing = code === 91 ? 93 : 41
    consume(code)
    return content
  }

  function content(code: number | null): State | undefined {
    if (code === null) return nok(code)
    if (code === 92) {
      consume(code)
      return escaped
    }
    hasContent = true
    consume(code)
    return content
  }

  function escaped(code: number | null): State | undefined {
    if (code === closing && hasContent) {
      consume(code)
      effects.exit("latexMath")
      return flow ? after : ok
    }
    if (code === null) return nok(code)
    consume(code)
    hasContent = true
    return content
  }

  function after(code: number | null): State | undefined {
    if (code === null || code < -2) return ok(code)
    if (code === 32 || code === -1 || code === -2) {
      effects.enter("whitespace")
      effects.consume(code)
      effects.exit("whitespace")
      return after
    }
    return nok(code)
  }
}

const text: Construct = { name: "latexMathText", tokenize }
const flow: Construct = { name: "latexMathFlow", tokenize, concrete: true }
const syntax: Extension = { text: { 92: text }, flow: { 92: flow } }
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    latexMath(token) {
      const source = this.sliceSerialize(token)
      const display = source.startsWith("\\[")
      const value = source.slice(2, -2).trim()
      this.enter(
        {
          type: display ? "math" : "inlineMath",
          value,
          data: {
            hName: display ? "div" : "code",
            hProperties: {
              className: [display ? "math-display" : "math-inline"],
            },
            hChildren: [{ type: "text", value }],
          },
        },
        token,
      )
    },
  },
  exit: {
    latexMath(token) {
      this.exit(token)
    },
  },
}

export function createLatexMathPlugin(): Plugin<[], Root> {
  return function () {
    const data = this.data()
    data.micromarkExtensions = [...(data.micromarkExtensions ?? []), syntax]
    data.fromMarkdownExtensions = [
      ...(data.fromMarkdownExtensions ?? []),
      fromMarkdown,
    ]
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexMath: "latexMath"
    latexMathData: "latexMathData"
  }
}
