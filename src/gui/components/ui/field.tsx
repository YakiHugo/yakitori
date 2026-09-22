import type { ComponentProps } from "react"
import { cn } from "../../lib/utils.ts"

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

export function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field"
      className={cn(
        "flex flex-col gap-2 data-[invalid=true]:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

export function FieldLabel({
  className,
  htmlFor,
  children,
  ...props
}: ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      htmlFor={htmlFor}
      className={cn("text-sm font-medium leading-5", className)}
      {...props}
    >
      {children}
    </label>
  )
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  )
}
