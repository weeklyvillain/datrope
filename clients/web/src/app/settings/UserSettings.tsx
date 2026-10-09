import { unwrap, type Session } from "@datrope/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorText } from "@/components/error-text";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { client, errorText, useApp } from "../../session";
import { NotificationSettings } from "./NotificationSettings";
import { ProfileSettings } from "./ProfileSettings";

export function UserSettings() {
  const me = useApp((s) => s.me);
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();

  const loadSessions = () => unwrap(client.api.GET("/api/sessions")).then((v) => setSessions(v ?? [])).catch((e) => setError(errorText(e)));
  useEffect(() => { void loadSessions(); }, []);

  if (!me) return null;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="border-b bg-card px-4 py-3"><h2>Your settings</h2></header>
      <div className="grid max-w-[860px] flex-1 content-start gap-6 overflow-y-auto p-6">
        <ProfileSettings />
        <NotificationSettings />

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
