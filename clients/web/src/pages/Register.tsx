import { unwrap, type InstanceInfo } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { useSubmit } from "@/hooks/use-submit";
import { AuthLayout } from "./AuthLayout";

export function Register() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<InstanceInfo>();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/instance")).then(setInfo).catch(() => undefined);
  }, []);

  const first = info && !info.has_users;
  if (info?.has_users && info.registration_mode === "admin_only") {
    return (
      <AuthLayout title="Registration is closed">
        <p>Ask the admin of this server to create an account for you.</p>
        <Link to="/login">Sign in</Link>
      </AuthLayout>
    );
  }
  const needsInvite = info?.has_users && info.registration_mode === "invite_only";

  return (
    <AuthLayout title={first ? "Create the admin account" : "Create an account"}>
      {first && <p className="text-muted-foreground">You are the first person here, so this account will run the server.</p>}
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await unwrap(client.api.POST("/api/auth/register", {
            body: {
              username, password, device_name: deviceName(), client: "web",
              ...(email ? { email } : {}),
              ...(invite ? { invite_code: invite.trim().replace(/^.*\/invite\//, "") } : {}),
            },
          }));
          nav("/", { replace: true });
        });
      }}>
        <FormField label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)}
          required minLength={2} maxLength={32} pattern="[A-Za-z0-9_.\-]+" hint="Letters, numbers, and _ . -" autoFocus />
        <FormField label="Email (optional)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <FormField label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
          required minLength={8} hint="At least 8 characters" />
        {(needsInvite || invite) && (
          <FormField label="Invite code or link" value={invite} onChange={(e) => setInvite(e.target.value)} required={needsInvite} />
        )}
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
      <p className="text-muted-foreground">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthLayout>
  );
}
