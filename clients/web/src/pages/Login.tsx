import { unwrap } from "@datrope/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName, safeNext } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { useSubmit } from "@/hooks/use-submit";
import { AuthLayout } from "./AuthLayout";

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();

  return (
    <AuthLayout title="Sign in">
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await unwrap(client.api.POST("/api/auth/login", {
            body: { login, password, device_name: deviceName(), client: "web" },
          }));
          nav(safeNext(params.get("next")), { replace: true });
        });
      }}>
        <FormField label="Username or email" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
        <FormField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="text-muted-foreground">New here? <Link to={`/register${location.search}`}>Create an account</Link></p>
    </AuthLayout>
  );
}
