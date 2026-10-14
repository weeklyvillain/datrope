import type { ServerPreview } from "@datrope/core";
import type { ReactNode } from "react";
import { Logo, ServerIconImage } from "@/components/logo";
import { cn } from "@/lib/utils";
import { client } from "../session";

/** The sign-in and registration pages: the server introduces itself on the left, the form sits on the right. */
export function AuthLayout({ title, lede, aside, children }: { title: string; lede?: string; aside: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-wrap pt-safe pb-safe">
      {aside}
      <main className="flex min-w-0 flex-[1_1_440px] flex-col px-6 py-8">
        <div className="grid flex-1 place-items-center">
          <div className="grid w-full max-w-[360px] gap-7">
            <div className="grid gap-1.5">
              <h1 className="text-[28px] leading-tight font-bold tracking-tight text-foreground">{title}</h1>
              {lede && <p className="text-muted-foreground">{lede}</p>}
            </div>
            {children}
          </div>
        </div>
        <p className="pt-6 text-center text-xs text-muted-foreground">Runs on Datrope</p>
      </main>
    </div>
  );
}

/** The left panel: the server's banner, or its mark in the palette's accent, behind `children`. */
export function AuthAside({ label, banner, children }: { label: string; banner?: string; children?: ReactNode }) {
  return (
    <section aria-label={label}
      className="relative flex min-h-[200px] flex-[1_1_560px] flex-col justify-end overflow-hidden border-border bg-sidebar p-6 sm:min-h-[360px] sm:p-14 min-[1048px]:border-r">
      {banner ? (
        <>
          <img src={client.url(banner)} alt="" className="absolute inset-0 size-full object-cover" />
          <div aria-hidden className="absolute inset-0 bg-linear-to-t from-sidebar from-30% via-sidebar/60 to-sidebar/20" />
        </>
      ) : (
        <Logo className="pointer-events-none absolute -top-44 -right-64 size-[920px] text-primary opacity-10" />
      )}
      <div className="relative flex max-w-[480px] flex-col gap-5">{children}</div>
    </section>
  );
}

/** The server's name, description and who is around. `eyebrow` sits above the name ("You're joining"). */
export function ServerShowcase({ preview, eyebrow }: { preview?: ServerPreview | null; eyebrow?: string }) {
  if (!preview) return <AuthAside label="Datrope" />;
  return (
    <AuthAside label={`About ${preview.name}`} banner={preview.banner_url}>
      <ServerIconImage src={preview.icon_url ? client.url(preview.icon_url) : undefined} name={preview.name} size={72}
        className="rounded-[18px] border border-border" />
      <div className="grid gap-2.5">
        {eyebrow && <p className="text-ui font-semibold tracking-wider text-primary uppercase">{eyebrow}</p>}
        <h2 className="text-4xl leading-[1.1] font-bold tracking-tight text-balance text-foreground sm:text-[44px]">{preview.name}</h2>
        {preview.description && <p className="max-w-[420px] text-[17px] leading-normal text-muted-foreground">{preview.description}</p>}
      </div>
      <ServerStats preview={preview} />
    </AuthAside>
  );
}

export function ServerStats({ preview, since, className }: { preview: ServerPreview; since?: string; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground", className)}>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-online" />{preview.online_count} online</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-offline" />{preview.member_count} {preview.member_count === 1 ? "member" : "members"}
      </span>
      {since && <span>Since {since}</span>}
    </p>
  );
}
