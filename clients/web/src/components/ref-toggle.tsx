import { forwardRef, type ComponentProps } from "react";
import { Toggle as TogglePrimitive } from "radix-ui";
import { toggleVariants, type Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

/** A `Toggle` that forwards its ref, for use as an `asChild` trigger (React 18 drops refs on `Toggle`). */
export const RefToggle = forwardRef<HTMLButtonElement, ComponentProps<typeof Toggle>>(
  ({ className, variant, size, ...props }, ref) => (
    <TogglePrimitive.Root ref={ref} data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} {...props} />
  ),
);
RefToggle.displayName = "RefToggle";
