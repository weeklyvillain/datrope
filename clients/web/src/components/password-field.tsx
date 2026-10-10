import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** A password input with a show/hide button; `meter` sits between the input and the hint. */
export function PasswordField({ label, hint, meter, className, ...props }: ComponentProps<"input"> & { label: string; hint?: string; meter?: ReactNode }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input id={id} {...props} type={shown ? "text" : "password"} aria-describedby={hint ? `${id}-hint` : undefined} className="pr-10" />
        <Button variant="ghost" size="icon-sm" className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
          aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      {meter}
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}
