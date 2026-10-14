import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 pointer-coarse:min-h-[44px]",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3 pointer-coarse:min-h-[44px]",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 pointer-coarse:min-h-[44px]",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 pointer-coarse:min-h-[44px]",
        icon: "size-9 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        "icon-sm": "size-8 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        "icon-lg": "size-10 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      type={asChild ? type : (type ?? "button")}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
