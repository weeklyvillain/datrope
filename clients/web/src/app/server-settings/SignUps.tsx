import { unwrap, type Settings, type User } from "@datrope/core";
import { Ellipsis } from "@/components/icons";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StackedList, StackedRow } from "@/components/stacked-rows";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSubmit } from "@/hooks/use-submit";
import { cn } from "@/lib/utils";
import { client, errorText, useApp } from "@/session";

type Mode = Settings["registration_mode"];
const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "open", label: "Open", hint: "Anyone who finds the server can create an account." },
  { value: "invite_only", label: "Invite only", hint: "People need an invite link to create an account." },
  { value: "admin_only", label: "Admin only", hint: "Only you create accounts, below." },
];

/** Who can create an account, and the instance's accounts (instance admin). */
export function SignUps() {
  const me = useApp((s) => s.me);
  const [users, setUsers] = useState<User[]>();
  const [error, setError] = useState<string>();
  const phone = useIsMobile();
  const loadUsers = () => {
    unwrap(client.api.GET("/api/admin/users")).then((v) => setUsers(v ?? [])).catch((e) => setError(errorText(e)));
  };
  useEffect(loadUsers, []);

  return (
    <>
      <RegistrationMode />
      <CreateUser onCreated={loadUsers} />
      <section className="grid gap-2" aria-labelledby="signups-users">
        <h3 id="signups-users" className="text-sm font-semibold">Accounts</h3>
        <ErrorText error={error} />
        {phone ? (
          <StackedList label="Accounts">
            {users?.map((u) => <UserRowPhone key={u.id} u={u} isMe={u.id === me?.id} onChange={loadUsers} />)}
          </StackedList>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users?.map((u) => <UserRow key={u.id} u={u} isMe={u.id === me?.id} onChange={loadUsers} />)}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

function RegistrationMode() {
  const id = useId();
  const [mode, setMode] = useState<Mode>();
  const { error, run } = useSubmit();
  useEffect(() => {
    void run(async () => setMode((await unwrap(client.api.GET("/api/admin/settings"))).registration_mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (m: Mode) => {
    const before = mode;
    setMode(m);
    void run(async () => {
      try {
        setMode((await unwrap(client.api.PATCH("/api/admin/settings", { body: { registration_mode: m } }))).registration_mode);
      } catch (e) {
        setMode(before);
        throw e;
      }
    });
  };

  return (
    <section className="grid gap-2" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="text-sm font-semibold">Who can create an account</h3>
      {mode && (
        <RadioGroup aria-labelledby={`${id}-h`} value={mode} onValueChange={(v) => choose(v as Mode)} className="gap-3">
          {MODES.map((m) => (
            <div key={m.value} className="flex items-start gap-2.5">
              <RadioGroupItem value={m.value} id={`${id}-${m.value}`} className="mt-1" />
              <Label htmlFor={`${id}-${m.value}`} className="grid gap-0.5 font-normal">
                <span className="font-semibold">{m.label}</span>
                <span className="text-sm text-muted-foreground">{m.hint}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
      <ErrorText error={error} />
    </section>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <form aria-label="Create account" className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        await unwrap(client.api.POST("/api/admin/users", { body: { username, password } }));
        setUsername("");
        setPassword("");
        onCreated();
      });
    }}>
      <h3 className="text-sm font-semibold">Create an account</h3>
      <div className="flex flex-wrap items-end gap-3">
        <FormField className="w-auto min-w-48 flex-1" label="Username" value={username} onChange={(e) => setUsername(e.target.value)}
          required minLength={2} maxLength={32} />
        <FormField className="w-auto min-w-48 flex-1" label="Temporary password" type="password" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <Button type="submit" disabled={busy}>Create</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function UserRow({ u, isMe, onChange }: { u: User; isMe: boolean; onChange: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: u.id } } };
  return (
    <TableRow>
      <TableCell>
        {u.display_name} <span className="text-muted-foreground">@{u.username}</span>
        {u.is_admin && " (admin)"}{u.disabled && <span className="text-muted-foreground"> · disabled</span>}
      </TableCell>
      <TableCell>
        {resetting ? (
          <form className="flex flex-wrap items-center justify-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await unwrap(client.api.PUT("/api/admin/users/{id}/password", { ...path, body: { password } }));
              setResetting(false);
              setPassword("");
            });
          }}>
            <Input type="password" aria-label={`New password for ${u.username}`} value={password} minLength={8} required
              className="w-48" onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <Button size="sm" type="submit" disabled={busy}>Set</Button>
            <Button size="sm" variant="outline" onClick={() => setResetting(false)}>Cancel</Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setResetting(true)}>Reset password</Button>
            {!isMe && (
              <Button size="sm" variant={u.disabled ? "outline" : "destructive"} disabled={busy} onClick={() => void run(async () => {
                await unwrap(client.api.PUT("/api/admin/users/{id}/disabled", { ...path, body: { disabled: !u.disabled } }));
                onChange();
              })}>{u.disabled ? "Enable" : "Disable"}</Button>
            )}
          </div>
        )}
        <ErrorText error={error} />
      </TableCell>
    </TableRow>
  );
}

function UserRowPhone({ u, isMe, onChange }: { u: User; isMe: boolean; onChange: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: u.id } } };
  return (
    <StackedRow
      primary={<span className="truncate">{u.display_name}{u.is_admin && " (admin)"}{u.disabled && <span className="text-muted-foreground"> · disabled</span>}</span>}
      secondary={`@${u.username}`}
      actions={(
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label={`Actions for ${u.username}`}
            className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}>
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setResetting(true)}>Reset password</DropdownMenuItem>
            {!isMe && (
              <DropdownMenuItem variant={u.disabled ? "default" : "destructive"} disabled={busy} onSelect={() => void run(async () => {
                await unwrap(client.api.PUT("/api/admin/users/{id}/disabled", { ...path, body: { disabled: !u.disabled } }));
                onChange();
              })}>{u.disabled ? "Enable" : "Disable"}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      below={(
        <>
          {resetting && (
            <form className="flex flex-wrap items-center gap-2 pb-2" onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await unwrap(client.api.PUT("/api/admin/users/{id}/password", { ...path, body: { password } }));
                setResetting(false);
                setPassword("");
              });
            }}>
              <Input type="password" aria-label={`New password for ${u.username}`} value={password} minLength={8} required
                className="min-w-0 flex-1" onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <Button size="sm" type="submit" disabled={busy}>Set</Button>
              <Button size="sm" variant="outline" onClick={() => setResetting(false)}>Cancel</Button>
            </form>
          )}
          <ErrorText error={error} />
        </>
      )} />
  );
}
