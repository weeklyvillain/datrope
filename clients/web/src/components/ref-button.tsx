import { forwardRef, type ComponentProps } from "react";
import { buttonVariants, type Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A `Button` that forwards its ref, for use as an `asChild` trigger (React 18 drops refs on `Button`). */
export const RefButton = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof Button>, "asChild">>(
  ({ className, variant = "default", size = "default", type = "button", ...props }, ref) => (
    <button ref={ref} type={type} data-slot="button" data-variant={variant} data-size={size}
      className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
RefButton.displayName = "RefButton";
