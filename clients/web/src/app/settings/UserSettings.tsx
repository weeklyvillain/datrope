import { unwrap, type PresenceStatus, type Session } from "@datrope/core";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorText } from "@/components/error-text";
import { Field, FieldLabel } from "@/components/ui/field";
import { FormField } from "@/components/form-field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useSubmit } from "@/hooks/use-submit";
import { choosePresence, client, errorText, useApp } from "../../session";

export function UserSettings() {
  const statusId = useId();
  const me = useApp((s) => s.me);
  const presence = useApp((s) => s.presence);
  const [name, setName] = useState(me?.display_name ?? "");
  const [customStatus, setCustomStatus] = useState(me?.custom_status ?? "");
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();
  const { busy, error: saveError, run } = useSubmit();

  const loadSessions = () => unwrap(client.api.GET("/api/sessions")).then((v) => setSessions(v ?? [])).catch((e) => setError(errorText(e)));
  useEffect(() => { void loadSessions(); }, []);

  if (!me) return null;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="border-b bg-card px-4 py-3"><h2>Your settings</h2></header>
      <div className="grid max-w-[860px] flex-1 content-start gap-6 overflow-y-auto p-6">
        <Card role="region" aria-label="Profile" className="gap-3 p-4">
          <h3>Profile</h3>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await client.updateMe({ display_name: name, custom_status: customStatus });
            });
          }}>
            <FormField className="w-auto min-w-48 flex-1" label="Display name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={32} />
            <FormField className="w-auto min-w-48 flex-1" label="Custom status" placeholder="What are you up to?" value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)} maxLength={80} />
            <Button type="submit" disabled={busy}>Save</Button>
          </form>
          <ErrorText error={saveError} />
          <Field>
            <FieldLabel htmlFor={statusId}>Status</FieldLabel>
            <NativeSelect id={statusId} value={presence} onChange={(e) => choosePresence(e.target.value as PresenceStatus)}>
              <NativeSelectOption value="online">Online</NativeSelectOption>
              <NativeSelectOption value="idle">Idle</NativeSelectOption>
              <NativeSelectOption value="invisible">Invisible (appear offline)</NativeSelectOption>
            </NativeSelect>
          </Field>
        </Card>

        <Card role="region" aria-label="Sessions" className="gap-3 p-4">
          <h3>Signed-in devices</h3>
          <ErrorText error={error} />
          <Table>
            <TableBody>
              {sessions?.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.device_name}{s.current && <strong> (this device)</strong>}</TableCell>
                  <TableCell className="text-muted-foreground">last used {new Date(s.last_used_at).toLocaleString()}</TableCell>
                  <TableCell>{!s.current && (
                    <Button variant="outline" onClick={() => unwrap(client.api.DELETE("/api/sessions/{id}", { params: { path: { id: s.id } } }))
                      .then(loadSessions).catch((e) => setError(errorText(e)))}>Sign out</Button>
                  )}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button variant="destructive" onClick={async () => {
            try {
              await unwrap(client.api.POST("/api/auth/logout"));
            } catch (e) {
              setError(errorText(e));
              return;
            }
            client.disconnect();
            window.location.assign("/login");
          }}>Sign out of this device</Button>
        </Card>

        {me.is_admin && <Link to="/server-settings" className="text-primary hover:underline">Server settings →</Link>}
      </div>
    </main>
  );
}
