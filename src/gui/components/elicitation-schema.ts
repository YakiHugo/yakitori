export type ElicitationValue = string | boolean | string[]
export type ElicitationField = Readonly<{
  name: string
  label: string
  description?: string
  type: "string" | "number" | "integer" | "boolean" | "array"
  required: boolean
  choices?: readonly Readonly<{ value: string; label: string }>[]
  defaultValue?: ElicitationValue
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  format?: string
}>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

// Validate the supported SDK form subset before rendering. Unknown constraints
// must not be dropped: that would present a different question to the user.
export function parseElicitationSchema(
  schema: unknown,
):
  | { fields: ElicitationField[]; error?: never }
  | { error: string; fields?: never } {
  const unsupported = (detail: string) => ({
    error: `This form cannot be displayed: ${detail}. You can decline or cancel this request.`,
  })
  if (
    !record(schema) ||
    schema.type !== "object" ||
    !record(schema.properties) ||
    Object.keys(schema).some(
      (key) => !["type", "properties", "required"].includes(key),
    ) ||
    (schema.required !== undefined && !stringList(schema.required))
  )
    return unsupported("unsupported object schema")
  const required = new Set((schema.required ?? []) as string[])
  if (
    [...required].some(
      (name) => !Object.hasOwn(schema.properties as object, name),
    )
  )
    return unsupported("a required field has no definition")
  const fields: ElicitationField[] = []
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!record(property)) return unsupported(`invalid field ${name}`)
    const type = property.type
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean" &&
      type !== "array"
    )
      return unsupported(`unsupported field type for ${name}`)
    const allowed = ["type", "title", "description", "default"]
    if (type === "string")
      allowed.push("enum", "oneOf", "minLength", "maxLength", "format")
    if (type === "number" || type === "integer")
      allowed.push("minimum", "maximum")
    if (type === "array") allowed.push("items", "minItems", "maxItems")
    if (Object.keys(property).some((key) => !allowed.includes(key)))
      return unsupported(`unsupported constraint for ${name}`)
    if (
      ["title", "description"].some(
        (key) =>
          property[key] !== undefined && typeof property[key] !== "string",
      )
    )
      return unsupported(`invalid label for ${name}`)
    for (const key of [
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ]) {
      const limit = property[key]
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isFinite(limit) ||
          (key !== "minimum" &&
            key !== "maximum" &&
            (!Number.isInteger(limit) || limit < 0)))
      )
        return unsupported(`invalid constraint for ${name}`)
    }
    for (const [min, max] of [
      ["minimum", "maximum"],
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
    ] as const)
      if (
        typeof property[min] === "number" &&
        typeof property[max] === "number" &&
        property[min] > property[max]
      )
        return unsupported(`conflicting constraints for ${name}`)
    if (
      property.format !== undefined &&
      !["email", "uri", "date", "date-time"].includes(String(property.format))
    )
      return unsupported(`unsupported format for ${name}`)
    let options = property
    if (type === "array") {
      if (!record(property.items))
        return unsupported(`invalid choices for ${name}`)
      options = property.items
      if (
        Object.keys(options).some(
          (key) => !["type", "enum", "anyOf"].includes(key),
        ) ||
        (options.type !== undefined && options.type !== "string")
      )
        return unsupported(`unsupported array items for ${name}`)
    }
    let choices: ElicitationField["choices"]
    const titled = type === "array" ? options.anyOf : options.oneOf
    if (options.enum !== undefined) {
      if (
        !stringList(options.enum) ||
        options.enum.length === 0 ||
        titled !== undefined
      )
        return unsupported(`invalid choices for ${name}`)
      choices = options.enum.map((value) => ({ value, label: value }))
    } else if (titled !== undefined) {
      if (!Array.isArray(titled) || titled.length === 0)
        return unsupported(`invalid choices for ${name}`)
      const parsed: { value: string; label: string }[] = []
      for (const option of titled) {
        if (
          !record(option) ||
          typeof option.const !== "string" ||
          typeof option.title !== "string" ||
          Object.keys(option).some((key) => key !== "const" && key !== "title")
        )
          return unsupported(`invalid choices for ${name}`)
        parsed.push({ value: option.const, label: option.title })
      }
      choices = parsed
    }
    if (type === "array" && choices === undefined)
      return unsupported(`unsupported array items for ${name}`)
    if (
      choices &&
      new Set(choices.map((choice) => choice.value)).size !== choices.length
    )
      return unsupported(`duplicate choices for ${name}`)
    const initial = property.default
    if (
      initial !== undefined &&
      !(
        (type === "string" && typeof initial === "string") ||
        (type === "boolean" && typeof initial === "boolean") ||
        ((type === "number" || type === "integer") &&
          typeof initial === "number" &&
          Number.isFinite(initial)) ||
        (type === "array" && stringList(initial))
      )
    )
      return unsupported(`invalid default for ${name}`)
    fields.push({
      name,
      type,
      label: typeof property.title === "string" ? property.title : name,
      required: required.has(name),
      ...(typeof property.description === "string"
        ? { description: property.description }
        : {}),
      ...(choices ? { choices } : {}),
      ...(initial === undefined
        ? {}
        : {
            defaultValue:
              typeof initial === "number"
                ? String(initial)
                : (initial as ElicitationValue),
          }),
      ...Object.fromEntries(
        [
          "minimum",
          "maximum",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "format",
        ]
          .filter((key) => property[key] !== undefined)
          .map((key) => [key, property[key]]),
      ),
    })
  }
  return { fields }
}

export function readElicitationValues(
  fields: readonly ElicitationField[],
  values: Readonly<Record<string, ElicitationValue | undefined>>,
): {
  content: Record<string, string | number | boolean | string[]>
  errors: Record<string, string>
} {
  const content: Record<string, string | number | boolean | string[]> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const value = Object.hasOwn(values, field.name)
      ? values[field.name]
      : undefined
    const fail = (message: string) => {
      Object.defineProperty(errors, field.name, {
        value: message,
        enumerable: true,
        configurable: true,
      })
    }
    if (
      value === undefined ||
      (value === "" && !field.choices?.some((choice) => choice.value === ""))
    ) {
      if (field.required) fail("This field is required.")
      continue
    }
    let parsed: string | number | boolean | string[] = value
    if (field.type === "number" || field.type === "integer") {
      parsed =
        typeof value === "string" && value.trim() ? Number(value) : Number.NaN
      if (
        !Number.isFinite(parsed) ||
        (field.type === "integer" && !Number.isInteger(parsed))
      )
        fail(
          field.type === "integer"
            ? "Enter a whole number."
            : "Enter a number.",
        )
      else if (field.minimum !== undefined && parsed < field.minimum)
        fail(`Enter a value of at least ${field.minimum}.`)
      else if (field.maximum !== undefined && parsed > field.maximum)
        fail(`Enter a value of at most ${field.maximum}.`)
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") fail("Choose Yes or No.")
    } else if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) => !field.choices?.some((choice) => choice.value === item),
        )
      )
        fail("Choose from the listed options.")
      else if (value.length < (field.minItems ?? (field.required ? 1 : 0)))
        fail(`Choose at least ${field.minItems ?? 1} option(s).`)
      else if (field.maxItems !== undefined && value.length > field.maxItems)
        fail(`Choose at most ${field.maxItems} option(s).`)
    } else if (typeof value !== "string") {
      fail("Enter text.")
    } else if (
      field.choices &&
      !field.choices.some((choice) => choice.value === value)
    ) {
      fail("Choose from the listed options.")
    } else if (
      field.minLength !== undefined &&
      [...value].length < field.minLength
    ) {
      fail(`Enter at least ${field.minLength} characters.`)
    } else if (
      field.maxLength !== undefined &&
      [...value].length > field.maxLength
    ) {
      fail(`Enter at most ${field.maxLength} characters.`)
    } else if (field.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(value)) {
      fail("Enter a valid email address.")
    } else if (field.format === "uri" && !URL.canParse(value)) {
      fail("Enter a valid URL.")
    } else if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    ) {
      fail("Enter a valid date (YYYY-MM-DD).")
    } else if (
      field.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        value,
      ) ||
        !Number.isFinite(Date.parse(value)))
    ) {
      fail("Enter a date and time with a time zone.")
    }
    Object.defineProperty(content, field.name, {
      value: parsed,
      enumerable: true,
      configurable: true,
    })
  }
  return { content, errors }
}
