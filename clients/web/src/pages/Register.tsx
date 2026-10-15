import { unwrap, type InstanceInfo } from "@datrope/core";
import { CheckIcon, Loader2Icon } from "@/components/icons";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client, deviceName } from "../session";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { PasswordField } from "@/components/password-field";
import { useSubmit } from "@/hooks/use-submit";
import { passwordStrength, STRENGTH_LABELS } from "@/lib/password-strength";
import { cn } from "@/lib/utils";
import { AuthAside, AuthLayout, ServerShowcase } from "./AuthLayout";
import { useServerPreview } from "./use-server-preview";

function StrengthMeter({ score }: { score: number }) {
  const fill = score <= 1 ? "bg-destructive" : score === 2 ? "bg-idle" : "bg-primary";
  return (
    <div aria-hidden className="grid grid-cols-4 gap-1">
      {[1, 2, 3, 4].map((i) => <span key={i} className={cn("h-1 rounded-full bg-muted", i <= score && fill)} />)}
    </div>
  );
}

function FirstRunSteps() {
  const steps = [
    ["Create the admin account", "This account owns the server."],
    ["Name it and pick a look", "Icon, banner, palette and the welcome page."],
    ["Invite people", "Send a link; they land on a page like this one."],
  ];
  return (
    <AuthAside label="Setting up a new server">
      <div className="grid gap-2.5">
        <p className="text-ui font-semibold tracking-wider text-primary uppercase">New server</p>
        <h2 className="text-4xl leading-[1.1] font-bold tracking-tight text-balance text-foreground sm:text-[44px]">Your Datrope server is up.</h2>
        <p className="text-[17px] leading-normal text-muted-foreground">Nobody has signed up yet. Three steps and your friends can move in.</p>
      </div>
      <ol className="mt-3 grid gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3.5">
            <span className={cn("grid size-8 place-items-center rounded-full border bg-card text-sm font-bold text-muted-foreground",
              i === 0 && "border-primary bg-primary text-primary-foreground")}>{i + 1}</span>
            <span><strong className="block text-foreground">{title}</strong><span className="text-sm text-muted-foreground">{text}</span></span>
          </li>
        ))}
      </ol>
    </AuthAside>
  );
}

export function Register() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const preview = useServerPreview();
  const [info, setInfo] = useState<InstanceInfo>();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const linkCode = params.get("invite")?.trim() ?? "";
  const [invite, setInvite] = useState(linkCode);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    unwrap(client.api.GET("/api/instance")).then(setInfo).catch(() => undefined);
  }, []);

  const first = info && !info.has_users;
  const aside = first ? <FirstRunSteps /> : <ServerShowcase preview={preview} eyebrow={linkCode ? "You're joining" : undefined} />;
  if (info?.has_users && info.registration_mode === "admin_only") {
    return (
      <AuthLayout title="Registration is closed" lede="Ask the admin of this server to create an account for you." aside={aside}>
        <p><Link to="/login">Sign in</Link></p>
      </AuthLayout>
    );
  }
  const needsInvite = info?.has_users && info.registration_mode === "invite_only";
  const score = passwordStrength(password);

  return (
    <AuthLayout
      title={first ? "Create the admin account" : "Create your account"}
      lede={first ? "You are the first one here, so this account will run the server." : "One account, then you are in."}
      aside={aside}>
      {linkCode && (
        <p className="flex items-center gap-3 rounded-lg border border-primary/45 bg-primary/8 px-3.5 py-3 text-sm">
          <CheckIcon className="size-4 flex-none text-primary" />
          <span>Invite <code className="font-mono text-ui text-foreground">{linkCode.replace(/^.*\/invite\//, "")}</code> applied</span>
        </p>
      )}
      <form className="grid gap-4" onSubmit={(e) => {
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
        <FormField label="Username" autoComplete="username" className="[&_input]:h-11" value={username} onChange={(e) => setUsername(e.target.value)}
          required minLength={2} maxLength={32} pattern="[A-Za-z0-9_.\-]+" hint="Letters, numbers, and _ . -" autoFocus />
        <FormField label="Email (optional)" type="email" autoComplete="email" className="[&_input]:h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="new-password" className="[&_input]:h-11" value={password} onChange={(e) => setPassword(e.target.value)}
          required minLength={8} meter={password && <StrengthMeter score={score} />}
          hint={password ? `${STRENGTH_LABELS[score]}. At least 8 characters.` : "At least 8 characters"} />
        {needsInvite && !linkCode && (
          <FormField label="Invite code or link" className="[&_input]:h-11" value={invite} onChange={(e) => setInvite(e.target.value)} required
            hint="This server is invite-only. Ask a member for a link." />
        )}
        <ErrorText error={error} />
        <Button type="submit" size="lg" className="mt-2 h-11 w-full" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      {!first && <p className="border-t pt-5 text-muted-foreground">Already have an account? <Link to="/login">Sign in</Link></p>}
    </AuthLayout>
  );
}
