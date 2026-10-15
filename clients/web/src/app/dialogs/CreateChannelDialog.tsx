import { unwrap } from "@datrope/core";
import { useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmojiInsertButton } from "@/chat/EmojiInsertButton";
import { RichInput, type RichInputHandle } from "@/chat/RichInput";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, useApp } from "../../session";
import { CHANNEL_TYPES, type CreatableChannelType } from "../channel-types";
import { TagsEditor } from "../TagsEditor";
import { GallerySourcesField, sourcesBody, type SourcesValue } from "../gallery/GallerySourcesField";

const PLACEHOLDERS: Record<CreatableChannelType, string> = {
  text: "general", voice: "Lounge", webhook: "alerts", announcement: "announcements", forum: "ideas", gallery: "photos",
};

export function CreateChannelDialog({ categoryId, onClose }: { categoryId?: string; onClose: () => void }) {
  const nav = useNavigate();
  const id = useId();
  const nameId = useId();
  const nameRef = useRef<RichInputHandle>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<CreatableChannelType>("text");
  const [tags, setTags] = useState(["Feature", "Bug", "Question"]);
  const [requireTag, setRequireTag] = useState(false);
  const [category, setCategory] = useState(categoryId ?? "");
  const [sources, setSources] = useState<SourcesValue>({ mode: "none", ids: [] });
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
          if (!name.trim()) return;
          void run(async () => {
            const ch = await unwrap(client.api.POST("/api/server/channels", { body: { name, type, ...(category && { category_id: category }), ...(type === "forum" && { tags, require_tag: requireTag && tags.length > 0 }), ...(type === "gallery" && sourcesBody(sources)) } }));
            client.apply("CHANNEL_CREATE", ch);
            onClose();
            nav(`/channels/${ch.id}`);
          });
        }}>
          <RadioGroup aria-label="Type" value={type} onValueChange={(v) => setType(v as CreatableChannelType)} className="gap-2">
            {CHANNEL_TYPES.map((t) => (
              <Label key={t.value} htmlFor={`${id}-${t.value}`}
                className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal", type === t.value ? "border-primary bg-accent" : "hover:bg-accent/50")}>
                <RadioGroupItem value={t.value} id={`${id}-${t.value}`} />
                <t.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="grid gap-0.5">
                  <span className="font-medium">{t.label}</span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          <Field>
            <FieldLabel id={`${nameId}-label`} onClick={() => nameRef.current?.focus()}>Name</FieldLabel>
            <div className="flex items-center gap-1">
              <RichInput ref={nameRef} id={nameId} aria-labelledby={`${nameId}-label`} singleLine variant="input" maxLength={100}
                placeholder={PLACEHOLDERS[type]} autoFocus
                value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} />
              <EmojiInsertButton field={nameRef} label="Insert emoji" value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} />
            </div>
          </Field>
          {categories.length > 0 && (
            <Field>
              <FieldLabel htmlFor={`${id}-category`}>Category</FieldLabel>
              <NativeSelect id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)}>
                <NativeSelectOption value="">No category</NativeSelectOption>
                {categories.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
          )}
          {type === "announcement" && <p className="text-sm text-muted-foreground">Members with Manage messages can post. Everyone else can react and reply in threads.</p>}
          {type === "gallery" && <GallerySourcesField value={sources} onChange={setSources} />}
          {type === "forum" && (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-tags`}>Tags</FieldLabel>
                <TagsEditor id={`${id}-tags`} value={tags} onChange={setTags} />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id={`${id}-require-tag`} checked={requireTag && tags.length > 0} disabled={tags.length === 0}
                  onCheckedChange={(v) => setRequireTag(v === true)} />
                <Label htmlFor={`${id}-require-tag`}>Require a tag on new posts</Label>
              </div>
            </>
          )}
          <ErrorText error={error} />
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim() || (type === "gallery" && sources.mode === "selected" && sources.ids.length === 0)}>Create</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
