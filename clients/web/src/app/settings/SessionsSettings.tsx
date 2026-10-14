import { unwrap, type Session } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StackedRows } from "@/components/stacked-rows";
import { useIsMobile } from "@/hooks/use-mobile";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { client, errorText } from "../../session";

/** My signed-in devices: sign one out, or this one. */
export function SessionsSettings() {
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();
  const phone = useIsMobile();

  const loadSessions = () => unwrap(client.api.GET("/api/sessions")).then((v) => setSessions(v ?? [])).catch((e) => setError(errorText(e)));
  useEffect(() => { void loadSessions(); }, []);

  const signOut = (s: Session) => unwrap(client.api.DELETE("/api/sessions/{id}", { params: { path: { id: s.id } } }))
    .then(loadSessions).catch((e) => setError(errorText(e)));
  return (
    <Card role="region" aria-label="Sessions" className="gap-3 p-4">
      <h3>Signed-in devices</h3>
      <ErrorText error={error} />
      {phone ? (
        <StackedRows label="Signed-in devices" items={sessions ?? []} getKey={(s) => s.id}
          primary={(s) => <span className="truncate">{s.device_name}{s.current && <strong> (this device)</strong>}</span>}
          secondary={(s) => `last used ${new Date(s.last_used_at).toLocaleString()}`}
          actions={(s) => !s.current && <Button variant="outline" onClick={() => void signOut(s)}>Sign out</Button>} />
      ) : (
      <Table>
        <TableBody>
          {sessions?.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.device_name}{s.current && <strong> (this device)</strong>}</TableCell>
              <TableCell className="text-muted-foreground">last used {new Date(s.last_used_at).toLocaleString()}</TableCell>
              <TableCell>{!s.current && (
                <Button variant="outline" onClick={() => void signOut(s)}>Sign out</Button>
              )}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      )}
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
  );
}
