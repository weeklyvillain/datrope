import { unwrap } from "@datrope/core";
import { Hash } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useRef, useState, type CSSProperties } from "react";
import { ErrorText } from "@/components/error-text";
import { Logo, ServerIcon } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { useSubmit } from "@/hooks/use-submit";
import { PALETTES, type Palette } from "@/lib/palettes";
import { client, useApp } from "@/session";

/** Palette, icon and banner (MANAGE_SERVER). The palette saves as soon as it is picked. */
export function Look() {
  const name = useApp((s) => s.server?.server.name ?? "");
  const saved = useApp((s) => s.server?.server.palette ?? "emerald");
  const [picked, setPicked] = useState<Palette>();
  const palette = picked ?? saved;
  const { error, run } = useSubmit();

  const pick = (p: Palette) => {
    setPicked(p);
    void run(async () => {
      try {
        client.apply("SERVER_UPDATE", await unwrap(client.api.PATCH("/api/server", { body: { palette: p } })));
      } finally {
        setPicked(undefined);
      }
    });
  };

  return (
    <>
      <p className="max-w-[68ch] text-muted-foreground">Choose how {name} looks for everyone: its palette, icon and banner.</p>
      <section className="grid gap-1.5" aria-labelledby="look-palette">
        <h3 id="look-palette" className="text-sm font-semibold">Palette</h3>
        <p className="text-sm text-muted-foreground">
          The accent colour for buttons, links, mentions, the active channel and the logo. Everyone sees the server in this palette.
        </p>
        <RadioGroup aria-labelledby="look-palette" value={palette} onValueChange={(v) => pick(v as Palette)}
          className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5">
          {(Object.keys(PALETTES) as Palette[]).map((p) => {
            const { label, accent } = PALETTES[p];
            return (
              <RadioGroupPrimitive.Item key={p} value={p} aria-label={label}
                style={{ "--swatch": accent } as CSSProperties}
                className="grid justify-items-start gap-2.5 rounded-lg border bg-card p-3 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:border-[var(--swatch)] data-[state=checked]:ring-1 data-[state=checked]:ring-[var(--swatch)]">
                <span className="flex gap-1" aria-hidden>
                  <span className="size-7 rounded-full bg-[var(--swatch)]" />
                  <span className="size-7 rounded-full bg-[var(--swatch)] opacity-25" />
                </span>
                <span className="text-sm font-semibold">{label}</span>
              </RadioGroupPrimitive.Item>
            );
          })}
        </RadioGroup>
        <ErrorText error={error} />
      </section>

      <section className="grid gap-1.5">
        <span className="text-sm font-semibold">Preview</span>
        <Preview name={name} accent={PALETTES[palette].accent} />
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <ImageUpload kind="icon" />
        <ImageUpload kind="banner" />
      </section>
    </>
  );
}

function Preview({ name, accent }: { name: string; accent: string }) {
  const style = { "--primary": accent, "--ring": accent } as CSSProperties;
  return (
    <div aria-label="Preview of the palette" style={style} className="grid min-h-[200px] grid-cols-[180px_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card">
      <div className="grid content-start gap-1 border-r bg-sidebar p-2.5 text-sm">
        <div className="flex items-center gap-2 px-1 pt-1 pb-2.5">
          <Logo className="size-5 text-primary" />
          <strong className="truncate">{name}</strong>
        </div>
        <span className="flex items-center gap-2 rounded-md bg-accent px-2 py-1.5"><Hash className="size-4" aria-hidden />general</span>
        <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground"><Hash className="size-4" aria-hidden />games</span>
      </div>
      <div className="grid content-start gap-3 bg-background p-3.5">
        <p>
          <span className="rounded bg-primary/20 px-1 font-semibold">@you</span> the new colours look great.{" "}
          <span className="text-primary underline-offset-4 hover:underline">See the docs</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" tabIndex={-1}>Send</Button>
          <Button size="sm" variant="outline" tabIndex={-1}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 8 << 20;

/** Uploads or removes the server icon or banner; SERVER_UPDATE brings the new URL. */
function ImageUpload({ kind }: { kind: "icon" | "banner" }) {
  const url = useApp((s) => (kind === "icon" ? s.server?.server.icon_url : s.server?.server.banner_url));
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const { busy, error: apiError, run } = useSubmit();
  const label = kind === "icon" ? "Server icon" : "Banner";

  const onFile = (f: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!f) return;
    setError(undefined);
    if (!IMAGE_TYPES.includes(f.type)) return setError("Choose a PNG, JPEG, WebP or GIF image.");
    if (f.size > MAX_IMAGE_BYTES) return setError("The image is larger than 8 MB.");
    void run(async () => { await client.uploadServerImage(kind, f); });
  };

  return (
    <div className="grid content-start gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      {kind === "icon" ? (
        <ServerIcon size={96} className="rounded-2xl border" />
      ) : url ? (
        <img src={client.url(url)} alt="Banner" className="h-24 w-full rounded-lg border object-cover" />
      ) : (
        <div className="grid h-24 place-items-center rounded-lg border border-dashed bg-primary/20 text-sm text-muted-foreground">No banner</div>
      )}
      <p className="text-sm text-muted-foreground">
        {kind === "icon"
          ? "Square, at least 256 px. Without one, the Datrope mark is used in the palette colour."
          : "Wide, about 1600 × 400 px. Shown on the welcome page."}
        {" "}PNG, JPEG, WebP or GIF, up to 8 MB.
      </p>
      <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} hidden aria-label={`${label} file`}
        onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}
          aria-label={`Upload ${label.toLowerCase()}`}>Upload</Button>
        {url && (
          <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${label.toLowerCase()}`}
            onClick={() => void run(() => client.deleteServerImage(kind))}>Remove</Button>
        )}
      </div>
      <ErrorText error={error ?? apiError} />
    </div>
  );
}
