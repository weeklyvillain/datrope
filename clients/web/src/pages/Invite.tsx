import { unwrap, type InvitePreview } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { client } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { useSubmit } from "@/hooks/use-submit";
import { AuthLayout } from "./AuthLayout";

export function InvitePage() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>();
  const [signedIn, setSignedIn] = useState(false);
  const [member, setMember] = useState(false);
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
