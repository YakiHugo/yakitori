import { basename } from "node:path"

export type CatastrophicCommandMatch = {
  readonly rule: "rm_root" | "wipe_disk" | "halt" | "fork_bomb"
}

const ROOT_CHILDREN = new Set([
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/home",
  "/Users",
  "/System",
  "/Library",
  "/opt",
  "/private",
  "/dev",
  "/tmp",
])

const HALT_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff"])

/**
 * A deliberately small last-chance fuse for commands that would destroy the
 * host. This is not a parser or a sandbox: uncertain shell syntax fails open.
 */
export function matchCatastrophicCommand(
  command: string,
): CatastrophicCommandMatch | undefined {
  if (command.replace(/[\t\n\r ]+/g, "") === ":(){:|:&};:") {
    return { rule: "fork_bomb" }
  }

  const heredocs = stripHeredocBodies(command)
  if (heredocs === undefined) return undefined
  const sources = executableSources(heredocs.executable)
  if (sources === undefined) return undefined
  for (const substitution of heredocs.substitutions) {
    const nested = executableSources(substitution)
    if (nested === undefined) return undefined
    sources.push(...nested)
  }
  const segments = sources.flatMap(
    (source) => splitExecutableSegments(source) ?? [],
  )
  for (const segment of segments) {
    const words = tokenizeSegment(segment)
    if (words === undefined) continue
    const invocation = unwrapCommand(words)
    if (invocation === undefined || invocation.length === 0) continue
    const commandWord = invocation[0]
    if (commandWord === undefined) continue
    const name = basename(commandWord)
    const operands = invocation.slice(1)

    if (
      (name === "rm" || name === "rmdir") &&
      hasCatastrophicRmPath(operands)
    ) {
      return { rule: "rm_root" }
    }
    if (isDiskWipe(name, operands)) return { rule: "wipe_disk" }
    if (isHaltCommand(commandWord, name)) return { rule: "halt" }
  }
  return undefined
}

type HeredocSpec = {
  readonly delimiter: string
  readonly stripTabs: boolean
  readonly quoted: boolean
}

function stripHeredocBodies(command: string):
  | {
      readonly executable: string
      readonly substitutions: readonly string[]
    }
  | undefined {
  const kept: string[] = []
  const pending: HeredocSpec[] = []
  const substitutions: string[] = []
  let bodyLines: string[] = []
  for (const line of command.split("\n")) {
    const current = pending[0]
    if (current !== undefined) {
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line
      if (candidate === current.delimiter) {
        if (!current.quoted) {
          const found = findHeredocSubstitutions(bodyLines.join("\n"))
          if (found === undefined) return undefined
          substitutions.push(...found)
        }
        pending.shift()
        bodyLines = []
      } else if (!current.quoted) {
        bodyLines.push(line)
      }
      continue
    }
    kept.push(line)
    const found = findHeredocs(line)
    if (found === undefined) return undefined
    pending.push(...found)
  }
  return pending.length === 0
    ? { executable: kept.join("\n"), substitutions }
    : undefined
}

function findHeredocSubstitutions(line: string): string[] | undefined {
  const substitutions: string[] = []
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === "\\") {
      index += 1
      continue
    }
    if (character === "`") {
      const end = findClosingBacktick(line, index + 1)
      if (end === undefined) return undefined
      substitutions.push(line.slice(index + 1, end))
      index = end
      continue
    }
    if (
      character === "$" &&
      line[index + 1] === "(" &&
      line[index + 2] !== "("
    ) {
      const end = findClosingParenthesis(line, index + 2)
      if (end === undefined) return undefined
      substitutions.push(line.slice(index + 2, end))
      index = end
    }
  }
  return substitutions
}

function findHeredocs(line: string): HeredocSpec[] | undefined {
  const found: HeredocSpec[] = []
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === undefined) continue
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (
      quote !== undefined ||
      character !== "<" ||
      line[index + 1] !== "<" ||
      line[index + 2] === "<"
    ) {
      continue
    }

    index += 2
    const stripTabs = line[index] === "-"
    if (stripTabs) index += 1
    while (line[index] === " " || line[index] === "\t") index += 1
    const parsed = parseHeredocDelimiter(line, index)
    if (parsed === undefined) return undefined
    found.push({
      delimiter: parsed.delimiter,
      stripTabs,
      quoted: parsed.quoted,
    })
    index = parsed.end - 1
  }
  return quote === undefined && !escaped ? found : undefined
}

function parseHeredocDelimiter(
  line: string,
  start: number,
):
  | {
      readonly delimiter: string
      readonly end: number
      readonly quoted: boolean
    }
  | undefined {
  let delimiter = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  let quoted = false
  let index = start
  for (; index < line.length; index += 1) {
    const character = line[index]
    if (character === undefined) continue
    if (escaped) {
      delimiter += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      quoted = true
      escaped = true
      continue
    }
    if (character === "'" && quote !== '"') {
      quoted = true
      quote = quote === "'" ? undefined : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quoted = true
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (quote === undefined && /[\t ;&|<>()]/.test(character)) break
    delimiter += character
  }
  if (delimiter.length === 0 || quote !== undefined || escaped) return undefined
  return { delimiter, end: index, quoted }
}

function executableSources(command: string): string[] | undefined {
  const sources = [command]
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === undefined) continue
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (quote === "'") continue

    if (character === "`") {
      const end = findClosingBacktick(command, index + 1)
      if (end === undefined) return undefined
      const nested = executableSources(command.slice(index + 1, end))
      if (nested === undefined) return undefined
      sources.push(...nested)
      index = end
      continue
    }
    if (
      character === "$" &&
      command[index + 1] === "(" &&
      command[index + 2] !== "("
    ) {
      const end = findClosingParenthesis(command, index + 2)
      if (end === undefined) return undefined
      const nested = executableSources(command.slice(index + 2, end))
      if (nested === undefined) return undefined
      sources.push(...nested)
      index = end
    }
  }
  return quote === undefined && !escaped ? sources : undefined
}

function findClosingBacktick(
  command: string,
  start: number,
): number | undefined {
  let escaped = false
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === "`") return index
  }
  return undefined
}

function findClosingParenthesis(
  command: string,
  start: number,
): number | undefined {
  let depth = 1
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]
    if (character === undefined) continue
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (quote !== undefined) continue
    if (character === "(") depth += 1
    if (character === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return undefined
}

function splitExecutableSegments(command: string): string[] | undefined {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  const flush = () => {
    if (current.trim().length > 0) segments.push(current.trim())
    current = ""
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === undefined) continue
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'"
      current += character
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"'
      current += character
      continue
    }
    if (quote === undefined && character === "#") {
      const previous = command[index - 1]
      if (index === 0 || previous === undefined || /[\t ]/.test(previous)) {
        while (index < command.length && command[index] !== "\n") index += 1
        flush()
        continue
      }
    }
    if (
      quote === undefined &&
      (character === ";" ||
        character === "\n" ||
        (character === "|" && command[index - 1] !== ">"))
    ) {
      flush()
      if (command[index + 1] === character) index += 1
      continue
    }
    if (
      quote === undefined &&
      character === "&" &&
      command[index - 1] !== ">" &&
      command[index + 1] !== ">"
    ) {
      flush()
      if (command[index + 1] === "&") index += 1
      continue
    }
    current += character
  }

  if (quote !== undefined || escaped) return undefined
  flush()
  return segments
}

function tokenizeSegment(segment: string): string[] | undefined {
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined

  const flush = () => {
    if (current.length > 0) words.push(current)
    current = ""
  }

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]
    if (character === undefined) continue
    if (character === "\\" && quote !== "'") {
      const next = segment[index + 1]
      if (next === undefined) return undefined
      if (
        quote === '"' &&
        next !== "$" &&
        next !== "`" &&
        next !== '"' &&
        next !== "\\" &&
        next !== "\n"
      ) {
        current += character
        continue
      }
      if (next !== "\n") current += next
      index += 1
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (quote === undefined && /[\t\r\n ]/.test(character)) {
      flush()
      continue
    }
    current += character
  }
  if (quote !== undefined) return undefined
  flush()
  return words
}

function unwrapCommand(
  words: readonly string[],
): readonly string[] | undefined {
  let invocation = [...words]
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(invocation[0] ?? "")) {
    invocation = invocation.slice(1)
  }

  for (let wrapperCount = 0; wrapperCount < 4; wrapperCount += 1) {
    const word = invocation[0]
    if (word === undefined) return []
    const name = basename(word)
    if (name === "command") {
      if (invocation[1] === "-v" || invocation[1] === "-V") return []
      invocation = invocation.slice(1)
      while (invocation[0] === "-p" || invocation[0] === "--") {
        invocation = invocation.slice(1)
      }
      continue
    }
    if (name === "nohup") {
      if (invocation[1] === "--help" || invocation[1] === "--version") {
        return []
      }
      invocation = invocation.slice(invocation[1] === "--" ? 2 : 1)
      continue
    }
    if (name === "sudo") {
      const next = consumeWrapperOptions(invocation, 1, SUDO_VALUE_OPTIONS)
      if (next === undefined) return []
      invocation = invocation.slice(next)
      continue
    }
    if (name === "env") {
      const unwrapped = unwrapEnvArguments(invocation.slice(1))
      if (unwrapped === undefined) return undefined
      invocation = unwrapped
      continue
    }
    break
  }
  return invocation
}

const SUDO_VALUE_OPTIONS = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-h",
  "--host",
  "-p",
  "--prompt",
  "-C",
  "--close-from",
  "-T",
  "--command-timeout",
  "-R",
  "--chroot",
  "-D",
  "--chdir",
  "-r",
  "--role",
  "-t",
  "--type",
])

const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"])

function unwrapEnvArguments(input: readonly string[]): string[] | undefined {
  let words = [...input]
  let index = 0
  while (index < words.length) {
    const word = words[index]
    if (word === undefined) return undefined
    if (word === "--") {
      words = words.slice(index + 1)
      index = 0
      break
    }
    if (word === "--help" || word === "--version") return []
    if (word === "-S" || word === "--split-string") {
      const value = words[index + 1]
      if (value === undefined) return undefined
      const split = tokenizeEnvSplitString(value)
      if (split === undefined) return undefined
      words = [...words.slice(0, index), ...split, ...words.slice(index + 2)]
      continue
    }
    if (word.startsWith("--split-string=")) {
      const split = tokenizeEnvSplitString(word.slice("--split-string=".length))
      if (split === undefined) return undefined
      words = [...words.slice(0, index), ...split, ...words.slice(index + 1)]
      continue
    }
    if (!word.startsWith("-") || word === "-") break
    const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word
    if (ENV_VALUE_OPTIONS.has(option) && option === word) {
      if (words[index + 1] === undefined) return undefined
      index += 2
      continue
    }
    index += 1
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1
  return words.slice(index)
}

function tokenizeEnvSplitString(value: string): string[] | undefined {
  let normalized = ""
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    const escaped = value[index + 1]
    if (character !== "\\" || escaped === undefined) {
      normalized += character
      continue
    }
    const whitespace = ENV_SPLIT_WHITESPACE.get(escaped)
    if (whitespace !== undefined) {
      normalized += whitespace
      index += 1
      continue
    }
    normalized += character + escaped
    index += 1
  }
  return tokenizeSegment(normalized)
}

const ENV_SPLIT_WHITESPACE = new Map([
  ["_", " "],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
])

function consumeWrapperOptions(
  words: readonly string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number | undefined {
  let index = start
  while (index < words.length) {
    const word = words[index]
    if (word === undefined) return undefined
    if (word === "--") return index + 1
    if (word === "--help" || word === "--version") return undefined
    if (!word.startsWith("-") || word === "-") return index
    const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word
    if (valueOptions.has(option) && option === word) {
      if (words[index + 1] === undefined) return undefined
      index += 2
      continue
    }
    index += 1
  }
  return index
}

function hasCatastrophicRmPath(words: readonly string[]): boolean {
  const optionEnd = words.indexOf("--")
  const activeOptions = optionEnd < 0 ? words : words.slice(0, optionEnd)
  if (activeOptions.some((word) => word === "--help" || word === "--version")) {
    return false
  }
  let optionsEnded = false
  for (const word of words) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && word.startsWith("-")) continue
    const path = word.length > 1 ? word.replace(/\/+$/, "") : word
    if (
      path === "/" ||
      path === "/*" ||
      path === "~" ||
      path === "$HOME" ||
      path === "$" + "{HOME}" ||
      /^(?:~|\$HOME|\$\{HOME\})\/(?:\*|\.\*|\{\*,\.\*\})$/.test(path) ||
      // An unexpanded variable followed by a glob (e.g. `rm -rf $UNSET/*`)
      // expands to `/*` when the variable is empty. This is the most common
      // real-world catastrophic rm form; block it like a literal root path.
      /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})\/(?:\*|\.\*|\{\*,\.\*\})$/.test(
        path,
      ) ||
      ROOT_CHILDREN.has(path)
    ) {
      return true
    }
  }
  return false
}

function isDiskWipe(name: string, words: readonly string[]): boolean {
  if (/^mkfs(?:\.|$)/.test(name) || /^newfs(?:[_.]|$)/.test(name)) return true
  if (
    name === "diskutil" &&
    words.some((word) => word === "eraseDisk" || word === "eraseVolume")
  ) {
    return true
  }
  if (name !== "dd") return false
  return words.some((word) =>
    /^of=\/dev\/(?:r?disk|sd|nvme)[A-Za-z0-9._-]*$/.test(word),
  )
}

function isHaltCommand(commandWord: string, name: string): boolean {
  if (!HALT_COMMANDS.has(name)) return false
  return (
    commandWord === name ||
    commandWord === `/sbin/${name}` ||
    commandWord === `/usr/sbin/${name}`
  )
}
