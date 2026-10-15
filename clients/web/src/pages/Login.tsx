import { unwrap } from "@datrope/core";
import { Loader2Icon } from "@/components/icons";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName, safeNext } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { PasswordField } from "@/components/password-field";
import { useSubmit } from "@/hooks/use-submit";
import { AuthLayout, ServerShowcase } from "./AuthLayout";
import { useServerPreview } from "./use-server-preview";

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const preview = useServerPreview();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();

  return (
    <AuthLayout title="Welcome back" lede="Sign in to pick up where you left off." aside={<ServerShowcase preview={preview} />}>
      <form className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await unwrap(client.api.POST("/api/auth/login", {
            body: { login, password, device_name: deviceName(), client: "web" },
          }));
          nav(safeNext(params.get("next")), { replace: true });
        });
      }}>
        <FormField label="Username or email" autoComplete="username" className="[&_input]:h-11" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
        <PasswordField label="Password" autoComplete="current-password" className="[&_input]:h-11" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorText error={error} />
        <Button type="submit" size="lg" className="mt-2 h-11 w-full" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="border-t pt-5 text-muted-foreground">New here? <Link to={`/register${location.search}`}>Create an account</Link></p>
    </AuthLayout>
  );
}
