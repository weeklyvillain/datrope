import { unwrap } from "@datrope/core";
import { useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "@/session";

/** Name and description (MANAGE_SERVER). */
export function Overview() {
  const descId = useId();
  const server = useApp((s) => s.server?.server);
  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();
  return (
    <form className="grid gap-4" onSubmit={(e) => {
      e.preventDefault();
      setSaved(false);
      void run(async () => {
        client.apply("SERVER_UPDATE", await unwrap(client.api.PATCH("/api/server", { body: { name, description } })));
        setSaved(true);
      });
    }}>
      <FormField label="Name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} required maxLength={100} />
      <Field>
        <FieldLabel htmlFor={descId}>Description</FieldLabel>
        <Textarea id={descId} value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} maxLength={300} rows={4} />
        <FieldDescription>Shown on the welcome page. {description.length} / 300</FieldDescription>
      </Field>
      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>Save</Button>
        {saved && <span role="status" className="text-muted-foreground">Saved</span>}
      </div>
    </form>
  );
}
