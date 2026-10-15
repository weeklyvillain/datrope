import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Toasts, bottom centre above the composer (so they never cover what you're typing), in the app's colours. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner theme="dark" position="bottom-center" offset={{ bottom: 88 }} mobileOffset={{ bottom: 120 }} className="toaster group"
      style={{ "--normal-bg": "var(--popover)", "--normal-text": "var(--popover-foreground)", "--normal-border": "var(--border)" } as React.CSSProperties}
      {...props} />
  );
}
