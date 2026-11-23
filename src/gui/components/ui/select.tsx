import {
  Content,
  Group,
  Icon,
  Item,
  ItemIndicator,
  ItemText,
  Label,
  Portal,
  Root,
  ScrollDownButton,
  ScrollUpButton,
  Trigger,
  Value,
  Viewport,
} from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import { type ComponentProps, useState } from "react"
import { cn } from "../../lib/utils.ts"
import "./select.css"

type SelectOption<T extends string | number> = Readonly<{
  value: T
  label: string
  disabled?: boolean
  group?: Readonly<{ id: string; label: string }>
}>

type SelectProps<T extends string | number> = Omit<
  ComponentProps<typeof Trigger>,
  "value" | "onChange" | "children"
> & {
  value: T
  options: readonly SelectOption<T>[]
  onValueChange(value: T): void
  placeholder?: string
  required?: boolean
  size?: "default" | "sm"
  variant?: "outline" | "ghost"
}

export function Select<T extends string | number>({
  value,
  options,
  onValueChange,
  placeholder = "Choose…",
  required,
  disabled,
  name,
  className,
  size = "default",
  variant = "outline",
  ...props
}: SelectProps<T>) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  // Prefix values so an explicit empty choice (e.g. "No project") remains selectable.
  const selected = options.find((option) => option.value === value)
  const grouped = new Map<
    string,
    { label: string; options: SelectOption<T>[] }
  >()
  for (const option of options) {
    if (option.group === undefined) continue
    const group = grouped.get(option.group.id)
    if (group !== undefined) group.options.push(option)
    else
      grouped.set(option.group.id, {
        label: option.group.label,
        options: [option],
      })
  }
  const renderOption = (option: SelectOption<T>) => (
    <Item
      key={option.value}
      value={`value:${option.value}`}
      disabled={option.disabled}
      className="ui-select-item"
    >
      <ItemText>{option.label}</ItemText>
      <ItemIndicator className="ui-select-indicator">
        <Check size={14} />
      </ItemIndicator>
    </Item>
  )
  return (
    <Root
      value={selected ? `value:${selected.value}` : ""}
      onValueChange={(next) => {
        const option = options.find((entry) => `value:${entry.value}` === next)
        if (option) onValueChange(option.value)
      }}
      disabled={disabled}
      required={required}
      name={name}
    >
      <Trigger
        ref={setTrigger}
        data-slot="select-trigger"
        data-size={size}
        data-variant={variant}
        className={cn("ui-select-trigger", className)}
        {...props}
      >
        <Value placeholder={placeholder} />
        <Icon asChild>
          <ChevronDown
            aria-hidden="true"
            size={14}
            className="ui-select-chevron"
          />
        </Icon>
      </Trigger>
      {/* Keep the popup inside a native dialog's top layer when used in one. */}
      <Portal container={trigger?.closest("dialog") ?? undefined}>
        <Content
          className="ui-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <ScrollUpButton className="ui-select-scroll">
            <ChevronUp size={14} />
          </ScrollUpButton>
          <Viewport className="ui-select-viewport">
            {options.map((option) => {
              if (option.group === undefined) return renderOption(option)
              const group = grouped.get(option.group.id)
              return group?.options[0] === option ? (
                <Group key={`group:${option.group.id}`}>
                  <Label className="px-2 py-1 text-xs text-muted-foreground">
                    {group.label}
                  </Label>
                  {group.options.map(renderOption)}
                </Group>
              ) : null
            })}
          </Viewport>
          <ScrollDownButton className="ui-select-scroll">
            <ChevronDown size={14} />
          </ScrollDownButton>
        </Content>
      </Portal>
    </Root>
  )
}
