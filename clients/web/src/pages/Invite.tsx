import { unwrap, type InvitePreview } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { client, deviceName } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { guestTtlText } from "@/lib/guest";
import { useSubmit } from "@/hooks/use-submit";
import { AuthLayout } from "./AuthLayout";

export function InvitePage() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>();
  const [signedIn, setSignedIn] = useState(false);
  const [member, setMember] = useState(false);
  const [nick, setNick] = useState("");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/invites/{code}", { params: { path: { code } } })).then(setPreview).catch(() => setPreview(null));
    unwrap(client.api.GET("/api/users/@me")).then(() => {
      setSignedIn(true);
      // Members can read the server; non-members get an error.
      return unwrap(client.api.GET("/api/server")).then(() => setMember(true), () => setMember(false));
    }).catch(() => setSignedIn(false));
  }, [code]);

  if (preview === undefined) return <AuthLayout title="Invite"><p className="text-muted-foreground">Loading…</p></AuthLayout>;
  if (preview === null) {
    return (
      <AuthLayout title="Invite not found">
        <p>This invite is invalid or has expired.</p>
        <Link to="/">Go home</Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={`Join ${preview.server_name}`}>
      <p className="text-muted-foreground">{preview.member_count} {preview.member_count === 1 ? "member" : "members"}</p>
      {member ? (
        <>
          <p>You're already a member.</p>
          <Link to="/">Go to {preview.server_name}</Link>
        </>
      ) : signedIn ? (
        <>
          <ErrorText error={error} />
          <Button className="self-start" disabled={busy} onClick={() => void run(async () => {
            await client.joinServer(code);
            nav("/");
          })}>Join</Button>
        </>
      ) : preview.guest_ttl_seconds ? (
        <form className="grid gap-3" aria-label="Join as guest" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await client.joinAsGuest(code, nick, deviceName());
            nav("/");
          });
        }}>
          <p>Join as a guest. Your access lasts {guestTtlText(preview.guest_ttl_seconds)}.</p>
          <FormField label="Nickname" value={nick} maxLength={32} required autoFocus onChange={(e) => setNick(e.target.value)} />
          <ErrorText error={error} />
          <Button type="submit" className="justify-self-start" disabled={busy}>Join as guest</Button>
          <Link to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Have an account? Sign in</Link>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link to={`/register?invite=${encodeURIComponent(code)}`}>Create account</Link>
          </Button>
          <Button asChild variant="outline" className="text-foreground">
            <Link to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}>Sign in</Link>
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
