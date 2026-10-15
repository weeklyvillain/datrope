import { unwrap, type InvitePreview, type User } from "@datrope/core";
import { CheckIcon, Unlink2Icon } from "@/components/icons";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { client, deviceName, errorText } from "../session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Logo, ServerIconImage } from "@/components/logo";
import { UserAvatar } from "@/components/user-avatar";
import { useSubmit } from "@/hooks/use-submit";
import { guestTtlText } from "@/lib/guest";
import { ServerStats } from "./AuthLayout";
import { sinceLabel, useServerPreview } from "./use-server-preview";

function Backdrop({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <Logo className="pointer-events-none absolute top-1/2 left-1/2 size-[1400px] -translate-x-1/2 -translate-y-[46%] text-primary opacity-[0.06]" />
      {children}
    </div>
  );
}

export function InvitePage() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const server = useServerPreview();
  const [invite, setInvite] = useState<InvitePreview | null>();
  const [me, setMe] = useState<User | null>();
  const [member, setMember] = useState(false);
  const [nick, setNick] = useState("");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/invites/{code}", { params: { path: { code } } })).then(setInvite).catch(() => setInvite(null));
    unwrap(client.api.GET("/api/users/@me")).then((u) => {
      setMe(u);
      // Members can read the server; non-members get an error.
      return unwrap(client.api.GET("/api/server")).then(() => setMember(true), () => setMember(false));
    }).catch(() => setMe(null));
  }, [code]);

  if (invite === null || server === null) {
    return (
      <Backdrop>
        <Card className="relative w-full max-w-[420px] justify-items-center gap-5 px-8 pt-10 pb-8 text-center shadow-2xl">
          <span className="grid size-16 place-items-center rounded-full bg-destructive/15 text-destructive">
            <Unlink2Icon className="size-7" />
          </span>
          <div className="grid gap-2">
            <h1 className="text-2xl leading-tight font-bold text-balance text-foreground">This invite doesn't work anymore</h1>
            <p className="text-muted-foreground">It may have expired or run out of uses. Ask whoever sent it for a fresh link.</p>
          </div>
          <Button asChild variant="outline" size="lg" className="h-11 w-full text-foreground">
            <Link to="/login">Go to sign in</Link>
          </Button>
        </Card>
      </Backdrop>
    );
  }
  if (invite === undefined || server === undefined || me === undefined) {
    return <Backdrop><p className="relative text-muted-foreground">Loading…</p></Backdrop>;
  }

  return (
    <Backdrop>
      <Card className="relative w-full max-w-[460px] gap-0 overflow-hidden py-0 shadow-2xl">
        <div aria-hidden className="relative h-[136px] overflow-hidden bg-[color-mix(in_srgb,var(--primary)_30%,var(--sidebar))]">
          {server.banner_url
            ? <img src={client.url(server.banner_url)} alt="" className="size-full object-cover" />
            : <Logo className="absolute -top-16 -right-10 size-64 text-primary opacity-40" />}
        </div>
        <div className="grid gap-6 px-8 pb-8">
          <ServerIconImage src={server.icon_url ? client.url(server.icon_url) : undefined} name={server.name} size={88}
            className="relative -mt-11 box-border rounded-[22px] border-[6px] border-card" />
          <div className="-mt-2 grid gap-2">
            <h1 className="grid gap-2">
              <span className="text-ui font-semibold tracking-wider text-primary uppercase">You're invited to join</span>{" "}
              <span className="text-[32px] leading-[1.15] font-bold tracking-tight text-balance text-foreground">{server.name}</span>
            </h1>
            {server.description && <p className="text-muted-foreground">{server.description}</p>}
            <ServerStats preview={server} since={sinceLabel(server.created_at)} className="mt-1" />
          </div>

          {member ? (
            <div className="grid gap-3.5">
              <p className="flex items-center gap-2.5 rounded-lg border border-online/40 bg-online/8 px-3.5 py-3 text-sm">
                <CheckIcon className="size-4 text-online" />You're already a member.
              </p>
              <Button asChild size="lg" className="h-12 w-full text-base"><Link to="/">Open {server.name}</Link></Button>
            </div>
          ) : me ? (
            <div className="grid gap-3.5">
              <ErrorText error={error} />
              <Button size="lg" className="h-12 w-full text-base" disabled={busy} onClick={() => void run(async () => {
                await client.joinServer(code);
                nav("/");
              })}>{busy ? "Joining…" : `Join ${server.name}`}</Button>
              <p className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                <UserAvatar user={me} size="xs" />
                Signed in as <strong className="text-foreground">{me.username}</strong> ·
                <Button variant="link" className="h-auto p-0" onClick={() => void unwrap(client.api.POST("/api/auth/logout"))
                  .then(() => window.location.reload(), (e: unknown) => window.alert(errorText(e)))}>Not you?</Button>
              </p>
            </div>
          ) : invite.guest_ttl_seconds ? (
            <form className="grid gap-3.5" aria-label="Join as guest" onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await client.joinAsGuest(code, nick, deviceName());
                nav("/");
              });
            }}>
              <p className="text-sm text-muted-foreground">Join as a guest, no account needed. Your access lasts {guestTtlText(invite.guest_ttl_seconds)}.</p>
              <FormField label="Nickname" className="[&_input]:h-11" value={nick} maxLength={32} required autoFocus onChange={(e) => setNick(e.target.value)} />
              <ErrorText error={error} />
              <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={busy}>{busy ? "Joining…" : "Join as guest"}</Button>
              <p className="text-center text-sm text-muted-foreground">
                Have an account? <Link to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Sign in</Link>
              </p>
            </form>
          ) : (
            <div className="grid gap-2.5">
              <Button asChild size="lg" className="h-12 w-full text-base">
                <Link to={`/register?invite=${encodeURIComponent(code)}`}>Create account and join</Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-12 w-full text-base text-foreground">
                <Link to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>I already have an account</Link>
              </Button>
            </div>
          )}
        </div>
      </Card>
    </Backdrop>
  );
}
