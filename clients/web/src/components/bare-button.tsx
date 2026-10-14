import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** An unstyled `<button>` surface (row, tile, card, inline chip) with only the focus ring. Forwards its ref for `asChild` triggers. */
export const BareButton = forwardRef<HTMLButtonElement, ComponentProps<"button">>(({ type = "button", className, ...props }, ref) => (
  <button ref={ref} type={type} className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props} />
));
BareButton.displayName = "BareButton";
