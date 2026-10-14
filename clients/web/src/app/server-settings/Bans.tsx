import { unwrap, type Ban } from "@datrope/core";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { StackedRows } from "@/components/stacked-rows";
import { useIsMobile } from "@/hooks/use-mobile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { client, displayName, errorText } from "@/session";

/** Banned users (BAN), with unban. */
export function Bans() {
  const [bans, setBans] = useState<Ban[]>();
  const [error, setError] = useState<string>();
  const phone = useIsMobile();
  const load = () => {
    unwrap(client.api.GET("/api/server/bans")).then((v) => setBans(v ?? [])).catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);
  const unban = (b: Ban) => unwrap(client.api.DELETE("/api/server/bans/{userID}", { params: { path: { userID: b.user.id } } }))
    .then(load).catch((e) => setError(errorText(e)));
  return (
    <>
      <ErrorText error={error} />
      {bans?.length === 0 ? <p className="text-muted-foreground">Nobody is banned.</p> : phone ? (
        <StackedRows label="Banned users" items={bans ?? []} getKey={(b) => b.user.id}
          primary={(b) => <span className="truncate">{displayName(b.user)} <span className="text-muted-foreground">@{b.user.username}</span></span>}
          secondary={(b) => b.reason || "No reason given"}
          actions={(b) => <Button size="sm" variant="outline" aria-label={`Unban ${displayName(b.user)}`} onClick={() => void unban(b)}>Unban</Button>} />
      ) : (
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
                    onClick={() => void unban(b)}>Unban</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
