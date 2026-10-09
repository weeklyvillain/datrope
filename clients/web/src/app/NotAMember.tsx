import { useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSubmit } from "@/hooks/use-submit";
import { client, errorText, signOut } from "../session";

/** "CODE" or ".../invite/CODE" → "CODE". */
export const inviteCode = (input: string) => input.trim().replace(/^.*\/invite\//, "").replace(/[/?#].*$/, "");

/** Shown instead of the app when I am signed in but not a member (e.g. after a kick). */
export function NotAMember() {
  const [invite, setInvite] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-[400px] gap-4 p-6">
        <Logo className="size-12 text-primary" />
        <h1 className="text-xl">You're not a member of this server</h1>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          void run(() => client.joinServer(inviteCode(invite)));
        }}>
          <FormField label="Invite link or code" value={invite} onChange={(e) => setInvite(e.target.value)} required autoFocus />
          <ErrorText error={error} />
          <Button type="submit" className="justify-self-start" disabled={busy}>Join</Button>
        </form>
        <Button variant="link" className="justify-self-start px-0" onClick={() => signOut().catch((e: unknown) => window.alert(errorText(e)))}>
          Sign out
        </Button>
      </Card>
    </main>
  );
}
