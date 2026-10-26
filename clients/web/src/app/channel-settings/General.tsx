import { unwrap, type Channel } from "@datrope/core";
import { useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmojiInsertButton } from "@/chat/EmojiInsertButton";
import { RichInput, type RichInputHandle } from "@/chat/RichInput";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { TagsEditor } from "../TagsEditor";
import { GallerySourcesField, sourcesBody, type SourcesValue } from "../gallery/GallerySourcesField";
import { liveIds, sourcesChanged } from "../gallery/sources";
import { client, useApp } from "../../session";

/** Name, topic, category and the type's own options (MANAGE_CHANNELS); deleting the channel. */
export function General({ ch }: { ch: Channel }) {
  const nav = useNavigate();
  const id = useId();
  const nameId = useId();
  const nameRef = useRef<RichInputHandle>(null);
  const [name, setName] = useState(ch.name);
  const [topic, setTopic] = useState(ch.topic);
  const [category, setCategory] = useState(ch.category_id ?? "");
  const [tags, setTags] = useState(ch.tags ?? []);
  const [requireTag, setRequireTag] = useState(ch.require_tag);
  const channels = useApp((s) => s.channels);
  const [sources, setSources] = useState<SourcesValue>({ mode: ch.gallery_sources ?? "none", ids: liveIds(ch.source_channel_ids, channels) });
  const [saved, setSaved] = useState(false);
  const byId = useApp((s) => s.server?.categories);
  const categories = useMemo(() => Object.values(byId ?? {}).sort((a, b) => a.position - b.position), [byId]);
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: ch.id } } };
  // A new category puts the channel at the end of that group.
  const move = category === (ch.category_id ?? "") ? {} : category ? { category_id: category } : { clear_category: true };
  return (
    <form className="grid gap-3" onInput={() => setSaved(false)} onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) return;
      setSaved(false);
      void run(async () => {
        client.apply("CHANNEL_UPDATE", await unwrap(client.api.PATCH("/api/channels/{id}", { ...path, body: { name, topic, ...move, ...(ch.type === "forum" && { tags, require_tag: requireTag && tags.length > 0 }), ...(ch.type === "gallery" && sourcesChanged(ch, sources, channels) && sourcesBody(sources)) } })));
        setSaved(true);
      });
    }}>
      <Field>
        <FieldLabel id={`${nameId}-label`} onClick={() => nameRef.current?.focus()}>Name</FieldLabel>
        <div className="flex items-center gap-1">
          <RichInput ref={nameRef} id={nameId} aria-labelledby={`${nameId}-label`} singleLine variant="input" maxLength={100}
            value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} />
          <EmojiInsertButton field={nameRef} label="Insert emoji" value={name} onChange={(v) => setName(Array.from(v).slice(0, 100).join(""))} />
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-topic`}>Topic</FieldLabel>
        <Textarea id={`${id}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} rows={3}
          className="max-h-48" />
      </Field>
      {ch.type !== "welcome" && categories.length > 0 && (
        <Field>
          <FieldLabel htmlFor={`${id}-category`}>Category</FieldLabel>
          <NativeSelect id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)}>
            <NativeSelectOption value="">No category</NativeSelectOption>
            {categories.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      )}
      {ch.type === "gallery" && <GallerySourcesField value={sources} onChange={setSources} selfId={ch.id} />}
      {ch.type === "forum" && (
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
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !name.trim() || (ch.type === "gallery" && sources.mode === "selected" && sources.ids.length === 0)}>Save</Button>
        {saved && <span role="status" className="text-muted-foreground">Saved</span>}
        {ch.type !== "welcome" && <Button variant="destructive" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete #${ch.name} and all its messages?`)) return;
          void run(async () => {
            await unwrap(client.api.DELETE("/api/channels/{id}", path));
            nav("/");
            client.apply("CHANNEL_DELETE", { id: ch.id });
          });
        }}>Delete channel</Button>}
      </div>
    </form>
  );
}
