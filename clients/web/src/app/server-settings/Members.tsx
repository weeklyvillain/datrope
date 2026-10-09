import { Perm, hasPerm, unwrap, type Member, type Role } from "@datrope/core";
import { Crown, Ellipsis } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { UserAvatar } from "@/components/user-avatar";
import { RoleBadge } from "@/components/role-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, displayName, errorText, useApp, usePerms } from "@/session";
import { useAssignableRoles } from "../people/use-assignable-roles";

type Action = { kind: "roles" | "kick" | "ban"; member: Member };

/** Everyone on the server (KICK, BAN or MANAGE_ROLES): search, roles, kick and ban, within the role hierarchy. */
export function Members() {
  const sv = useApp((s) => s.server);
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<Action>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    client.loadMembers().catch((e: unknown) => setError(errorText(e)));
  }, []);

  const q = query.trim().toLowerCase();
  const rows = Object.values(sv?.members ?? {})
    .filter((m) => !q || displayName(m.user).toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q))
    .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));

  return (
    <>
      <Input aria-label="Search members" placeholder="Search members" value={query} onChange={(e) => setQuery(e.target.value)}
        className="max-w-sm" />
      <ErrorText error={error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Roles</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => <MemberRow key={m.user.id} m={m} onAction={(kind) => setAction({ kind, member: m })} />)}
        </TableBody>
      </Table>
      {rows.length === 0 && <p className="text-muted-foreground">Nobody matches.</p>}

      {action?.kind === "roles" && <ManageRoles userId={action.member.user.id} onClose={() => setAction(undefined)} />}
      {(action?.kind === "kick" || action?.kind === "ban") && (
        <Remove kind={action.kind} member={action.member} onClose={() => setAction(undefined)} />
      )}
    </>
  );
}

/** One member's row: roles, joined date and the actions I may take on them, within the role hierarchy. */
function MemberRow({ m, onAction }: { m: Member; onAction: (kind: Action["kind"]) => void }) {
  const sv = useApp((s) => s.server);
  const meId = useApp((s) => s.me?.id);
  const perms = usePerms();
  const { held, canEdit: canRoles, above } = useAssignableRoles(m.user.id);
  const name = displayName(m.user);
  const owner = m.user.id === sv?.server.owner_id;
  const self = m.user.id === meId;
  const canKick = !owner && !self && above && hasPerm(perms, Perm.Kick);
  const canBan = !owner && !self && above && hasPerm(perms, Perm.Ban);
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2.5">
          <UserAvatar user={m.user} size="md" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium">
              {name}
              {owner && <Crown className="size-3.5 text-primary" aria-label="Server owner" />}
            </span>
            <span className="block text-sm text-muted-foreground">@{m.user.username}</span>
          </span>
        </span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="flex flex-wrap gap-1">
          {held.map((r) => <RoleBadge key={r.id} role={r} />)}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">{new Date(m.joined_at).toLocaleDateString()}</TableCell>
      <TableCell className="text-right">
        {(canRoles || canKick || canBan) && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger aria-label={`Actions for ${name}`}
              className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}>
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canRoles && <DropdownMenuItem onSelect={() => onAction("roles")}>Manage roles</DropdownMenuItem>}
              {canRoles && (canKick || canBan) && <DropdownMenuSeparator />}
              {canKick && <DropdownMenuItem variant="destructive" onSelect={() => onAction("kick")}>Kick</DropdownMenuItem>}
              {canBan && <DropdownMenuItem variant="destructive" onSelect={() => onAction("ban")}>Ban</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Ticks roles on and off for one member; each change applies at once. */
function ManageRoles({ userId, onClose }: { userId: string; onClose: () => void }) {
  const member = useApp((s) => s.server?.members[userId]);
  const { busy, error, run } = useSubmit();
  const base = useId();
  const { removable, addable } = useAssignableRoles(userId);
  const roles = [...removable, ...addable].sort((a, b) => b.position - a.position);
  if (!member) return null;
  const held = member.role_ids ?? [];
  const toggle = (r: Role, on: boolean) => void run(async () => {
    const opts = { params: { path: { userID: userId, roleID: r.id } } };
    await unwrap(on
      ? client.api.PUT("/api/server/members/{userID}/roles/{roleID}", opts)
      : client.api.DELETE("/api/server/members/{userID}/roles/{roleID}", opts));
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Roles for ${displayName(member.user)}`}</DialogTitle>
          <DialogDescription>You can hand out roles below your highest role.</DialogDescription>
        </DialogHeader>
        <ul className="grid max-h-80 overflow-y-auto">
          {roles.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-accent">
              <Checkbox id={`${base}-${r.id}`} checked={held.includes(r.id)} disabled={busy}
                onCheckedChange={(v) => toggle(r, v === true)} />
              <Label htmlFor={`${base}-${r.id}`} className="flex-1 font-normal"><RoleBadge role={r} /></Label>
            </li>
          ))}
        </ul>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms a kick, or a ban with an optional reason. */
function Remove({ kind, member, onClose }: { kind: "kick" | "ban"; member: Member; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  const name = displayName(member.user);
  const userID = member.user.id;
  const confirm = () => void run(async () => {
    if (kind === "kick") await unwrap(client.api.DELETE("/api/server/members/{userID}", { params: { path: { userID } } }));
    else await unwrap(client.api.PUT("/api/server/bans/{userID}", { params: { path: { userID } }, body: { reason: reason.trim() } }));
    client.apply("MEMBER_REMOVE", { user_id: userID });
    onClose();
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === "kick" ? `Kick ${name}?` : `Ban ${name}?`}</DialogTitle>
          <DialogDescription>
            {kind === "kick"
              ? "They are removed from the server. They can come back with a new invite."
              : "They are removed from the server, signed out, and cannot come back until unbanned."}
          </DialogDescription>
        </DialogHeader>
        {kind === "ban" && (
          <div className="grid gap-2">
            <Label htmlFor="ban-reason">Reason (optional)</Label>
            <Textarea id="ban-reason" value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={confirm}>{kind === "kick" ? "Kick" : "Ban"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
