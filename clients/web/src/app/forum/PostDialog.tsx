import { Perm, hasPerm, type ThreadListItem } from "@datrope/core";
import { CirclePlus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { client, formatBytes, useApp, usePerms } from "../../session";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { useSubmit } from "@/hooks/use-submit";
import { useUploads } from "@/hooks/use-uploads";
import { cn } from "@/lib/utils";

const MAX_TAGS = 5;
const MAX_LENGTH = 4000;

/** Starts a post in a forum, or (with `post`) edits a post's title and tags. Uploads go to the forum;
 *  the server moves them into the new post. */
export function PostDialog({ forumId, post, onClose, onSaved }: {
  forumId: string; post?: ThreadListItem; onClose: () => void; onSaved?: (postId: string) => void;
}) {
  const id = useId();
  const forum = useApp((s) => s.channels[forumId]);
  const perms = usePerms(forumId);
  const [title, setTitle] = useState(post?.channel.name ?? "");
  const [tags, setTags] = useState<string[]>(() => (post?.channel.tags ?? []).filter((t) => forum?.tags?.includes(t)));
  const [content, setContent] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const uploads = useUploads(forumId, { onError: setInvalid });
  const { files, uploading, ready, add } = uploads;
  const picker = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useSubmit();
  const offered = forum?.tags ?? [];
  const requireTag = !!forum?.require_tag;
  const canAttach = !post && hasPerm(perms, Perm.AttachFiles);
  const toggle = (t: string, on: boolean) => setTags((ts) => (on ? [...ts, t] : ts.filter((x) => x !== t)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{post ? "Edit post" : "New post"}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          if (requireTag && tags.length === 0) {
            setInvalid("Pick at least one tag.");
            return;
          }
          setInvalid(undefined);
          void run(async () => {
            const name = title.trim();
            if (post) {
              await client.updatePost(post.channel.id, { title: name, tags });
            } else {
              const item = await client.createPost(forumId, { title: name, content: content.trim(), tags, attachments: ready });
              onSaved?.(item.channel.id);
            }
            onClose();
          });
        }}>
          <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} autoFocus />
          {offered.length > 0 && (
            <FieldSet className="gap-2">
              <FieldLegend variant="label" className="mb-0">Tags</FieldLegend>
              <div className="flex flex-wrap gap-1.5">
                {offered.map((t) => {
                  const on = tags.includes(t);
                  return (
                    <Toggle key={t} variant="outline" size="sm" pressed={on} disabled={!on && tags.length >= MAX_TAGS}
                      onPressedChange={(v) => toggle(t, v)}
                      className="h-7 rounded-full px-3 text-ui font-normal text-muted-foreground data-[state=on]:border-foreground data-[state=on]:font-semibold data-[state=on]:text-foreground">
                      {t}
                    </Toggle>
                  );
                })}
              </div>
              <FieldDescription>{requireTag ? "Pick at least one tag." : `Up to ${MAX_TAGS} tags.`}</FieldDescription>
            </FieldSet>
          )}
          {!post && (
            <Field>
              <FieldLabel htmlFor={`${id}-message`}>Message</FieldLabel>
              <Textarea id={`${id}-message`} className="min-h-28" value={content} onChange={(e) => setContent(e.target.value)} maxLength={MAX_LENGTH} />
            </Field>
          )}
          {canAttach && (
            <div className="grid gap-2">
              {files.length > 0 && (
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Attachments">
                  {files.map((f) => (
                    <li key={f.key} className={cn("inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pl-2.5 pr-1 text-sm", f.error && "border-destructive")}>
                      <span>{f.name}</span>
                      <span className="text-muted-foreground">{f.error ?? (f.attachment ? formatBytes(f.size) : "Uploading…")}</span>
                      <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`}
                        onClick={() => uploads.remove(f.key)}>×</Button>
                    </li>
                  ))}
                </ul>
              )}
              <input ref={picker} type="file" multiple hidden
                onChange={(e) => {
                  if (e.target.files) add(Array.from(e.target.files));
                  e.target.value = "";
                }} />
              <Button variant="outline" size="sm" className="w-fit" onClick={() => picker.current?.click()}><CirclePlus /> Attach files</Button>
            </div>
          )}
          <ErrorText error={invalid ?? error} />
          <DialogFooter>
            <Button type="submit" disabled={busy || uploading || !title.trim() || (!post && !content.trim() && ready.length === 0)}>
              {post ? "Save" : "Post"}
            </Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
