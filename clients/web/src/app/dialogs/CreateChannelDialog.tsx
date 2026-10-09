import { unwrap } from "@datrope/core";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "../../session";

export function CreateChannelDialog({ categoryId, onClose }: { categoryId?: string; onClose: () => void }) {
  const nav = useNavigate();
  const id = useId();
  const [name, setName] = useState("");
  const [type, setType] = useState<"text" | "voice">("text");
  const [category, setCategory] = useState(categoryId ?? "");
  const byId = useApp((s) => s.server?.categories);
  const categories = useMemo(() => Object.values(byId ?? {}).sort((a, b) => a.position - b.position), [byId]);
  const { busy, error, run } = useSubmit();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const ch = await unwrap(client.api.POST("/api/server/channels", { body: { name, type, ...(category && { category_id: category }) } }));
            client.apply("CHANNEL_CREATE", ch);
            onClose();
            nav(`/channels/${ch.id}`);
          });
        }}>
          <div className="flex items-center gap-4">
            <span id={`${id}-type`} className="text-muted-foreground">Type</span>
            <RadioGroup aria-labelledby={`${id}-type`} value={type} onValueChange={(v) => setType(v as typeof type)} className="flex gap-4">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="text" id={`${id}-text`} />
                <Label htmlFor={`${id}-text`}>Text</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="voice" id={`${id}-voice`} />
                <Label htmlFor={`${id}-voice`}>Voice</Label>
              </div>
            </RadioGroup>
          </div>
          <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
          {categories.length > 0 && (
            <Field>
              <FieldLabel htmlFor={`${id}-category`}>Category</FieldLabel>
              <NativeSelect id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)}>
                <NativeSelectOption value="">No category</NativeSelectOption>
                {categories.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
          )}
          <ErrorText error={error} />
          <DialogFooter>
            <Button type="submit" disabled={busy}>Create</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
