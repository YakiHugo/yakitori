import {
  Content,
  Icon,
  Item,
  ItemIndicator,
  ItemText,
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

type SelectProps<T extends string | number> = Omit<
  ComponentProps<typeof Trigger>,
  "value" | "onChange" | "children"
> & {
  value: T
  options: readonly Readonly<{ value: T; label: string; disabled?: boolean }>[]
  onValueChange(value: T): void
  placeholder?: string
  required?: boolean
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
  ...props
}: SelectProps<T>) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  // Prefix values so an explicit empty choice (e.g. "No project") remains selectable.
  const selected = options.find((option) => option.value === value)
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
        className={cn("ui-select-trigger", className)}
        {...props}
      >
        <Value placeholder={placeholder} />
        <Icon asChild>
          <ChevronDown size={14} className="ui-select-chevron" />
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
            {options.map((option) => (
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
            ))}
          </Viewport>
          <ScrollDownButton className="ui-select-scroll">
            <ChevronDown size={14} />
          </ScrollDownButton>
        </Content>
      </Portal>
    </Root>
  )
}
