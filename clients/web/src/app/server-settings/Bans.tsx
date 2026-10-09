import { unwrap, type Ban } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { client, displayName, errorText } from "@/session";

/** Banned users (BAN), with unban. */
export function Bans() {
  const [bans, setBans] = useState<Ban[]>();
  const [error, setError] = useState<string>();
  const load = () => {
    unwrap(client.api.GET("/api/server/bans")).then((v) => setBans(v ?? [])).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);
  return (
    <>
      <ErrorText error={error} />
      {bans?.length === 0 ? <p className="text-muted-foreground">Nobody is banned.</p> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Banned</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bans?.map((b) => (
              <TableRow key={b.user.id}>
                <TableCell>{displayName(b.user)} <span className="text-muted-foreground">@{b.user.username}</span></TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{b.reason || "No reason given"}</TableCell>
                <TableCell>{new Date(b.created_at).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" aria-label={`Unban ${displayName(b.user)}`}
                    onClick={() => unwrap(client.api.DELETE("/api/server/bans/{userID}", { params: { path: { userID: b.user.id } } }))
                      .then(load).catch((e) => setError(errorText(e)))}>Unban</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
