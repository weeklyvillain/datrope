import { sidebarChannelIds, unwrap, type Welcome } from "@datrope/core";
import { BookOpen, Hash, ImagePlus } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { useTitleBarClass, useTitleBarEdges } from "@/hooks/use-title-bar-edges";
import { cn } from "@/lib/utils";
import { client, useApp } from "@/session";
import { WelcomeMarkdown } from "./WelcomeMarkdown";

const MAX = 50_000;

/** Edits the welcome page in place: Markdown on the left, live preview on the right. */
export function WelcomeEditor({ welcome, onClose }: { welcome: Welcome; onClose: () => void }) {
  const edges = useTitleBarEdges();
  const bandClass = useTitleBarClass("flex min-h-14 flex-none flex-wrap items-center gap-3 border-b bg-card py-2 pr-3 pl-4");
  const [markdown, setMarkdown] = useState(welcome.markdown);
  const [gate, setGate] = useState(welcome.rules_gate);
  // Textarea (React 18) doesn't forward refs; keep the element from its focus and selection events.
  const area = useRef<HTMLTextAreaElement | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const channelIds = useApp(useShallow((s) => sidebarChannelIds(s).filter((id) => s.channels[id] && s.channels[id].type !== "welcome")));
  const channels = useApp((s) => s.channels);
  const save = useSubmit();
  const upload = useSubmit();

  const blank = !markdown.trim();
  const over = markdown.length > MAX;
  const dirty = markdown !== welcome.markdown || gate !== welcome.rules_gate;

  /** Replaces the selection with text (on its own lines when block is set) and puts the cursor after it. */
  const insert = (text: string, block = false) => {
    const el = area.current;
    // The controlled textarea's value is the latest text, even after an upload finishes.
    const md = el?.value ?? markdown;
    const start = el?.selectionStart ?? md.length;
    const end = el?.selectionEnd ?? md.length;
    const before = md.slice(0, start);
    const after = md.slice(end);
    if (block) {
      if (before && !before.endsWith("\n")) text = "\n" + text;
      if (!after.startsWith("\n")) text += "\n";
    }
    setMarkdown(before + text + after);
    const pos = start + text.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    void upload.run(async () => {
      const { url } = await client.uploadServerImage("page", f);
      insert(`![](${url})`);
    });
  };

  const onSave = () =>
    void save.run(async () => {
      // Always send rules_gate: leaving it out turns the gate off.
      const w = await unwrap(client.api.PUT("/api/server/welcome", { body: { markdown, rules_gate: gate && !blank } }));
      client.apply("WELCOME_UPDATE", w);
      onClose();
    });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Edit welcome page">
      <header ref={edges} data-titlebar-drag className={bandClass}>
        <BookOpen className="size-4 text-muted-foreground" aria-hidden />
        <h2>Edit welcome page</h2>
        <span className="flex-1 text-sm text-muted-foreground">{dirty ? "Unsaved changes" : ""}</span>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={save.busy || over || !dirty} onClick={onSave}>Save page</Button>
      </header>
      <div className="flex flex-none flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 text-sm">
        <div className="grid gap-1">
          <Label className="font-normal">
            <Checkbox checked={gate} disabled={blank} onCheckedChange={(v) => setGate(v === true)} />
            Require new members to accept the rules
          </Label>
          {blank && <p className="pl-6 text-xs text-muted-foreground">Write the page first: members accept the rules on it.</p>}
        </div>
        <p className="text-muted-foreground">
          Banner and icon are set in <Link to="/server-settings/look" className="text-primary hover:underline">Server settings → Look</Link>.
        </p>
      </div>
      <ErrorText error={save.error ?? upload.error} />
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(20rem,1fr)] overflow-y-auto md:grid-cols-2 md:auto-rows-auto md:overflow-hidden">
        <section aria-label="Markdown" className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
          <div role="toolbar" aria-label="Insert" className="flex flex-none flex-wrap items-center gap-1 border-b bg-card px-2.5 py-1.5">
            <Button variant="ghost" size="sm" disabled={upload.busy} onClick={() => file.current?.click()}><ImagePlus />Insert image</Button>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }} />
            <DropdownMenu>
              <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "sm" })} disabled={channelIds.length === 0}>
                <Hash />Insert channel card
              </DropdownMenuTrigger>
              {/* Keep focus in the textarea after inserting, not back on the trigger. */}
              <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
                {channelIds.map((id) => (
                  <DropdownMenuItem key={id} onSelect={() => insert(`[[channel:${channels[id].name} "Describe this channel"]]`, true)}>
                    <Hash />{channels[id].name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className={cn("ml-auto text-xs tabular-nums text-muted-foreground", over && "text-destructive")}>
              {markdown.length.toLocaleString("en-US")} / {MAX.toLocaleString("en-US")}
            </span>
          </div>
          <Textarea aria-label="Welcome page in Markdown" spellCheck={false} value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            onFocus={(e) => (area.current = e.currentTarget)} onSelect={(e) => (area.current = e.currentTarget)} aria-invalid={over || undefined}
            className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 font-mono text-title md:text-ui leading-relaxed shadow-none field-sizing-fixed focus-visible:ring-0" />
        </section>
        <section aria-label="Preview" className="flex min-h-0 flex-col">
          <div className="flex h-[45px] flex-none items-center border-b bg-card px-3.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Preview</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {blank ? <p className="text-muted-foreground">Nothing here yet.</p> : <WelcomeMarkdown markdown={markdown} preview />}
          </div>
        </section>
      </div>
    </main>
  );
}
