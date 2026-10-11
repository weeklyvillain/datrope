import { isGated, myRoleIds } from "@datrope/core";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { RoleIcon } from "@/components/role-icon";
import { Switch } from "@/components/ui/switch";
import { client, errorText, useApp } from "@/session";
import { pickableRoles } from "./selfRoles";

/** "Pick your roles": switches for the self-assignable roles. Changes save at once. */
export function SelfRolePicker() {
  const roles = useApp(useShallow((s) => pickableRoles(s.server?.roles ?? {})));
  const held = useApp(useShallow(myRoleIds));
  const gated = useApp(isGated);
  const guest = useApp((s) => !!s.me?.guest_expires_at);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // optimistic state while saving
  const [error, setError] = useState<string>();
  if (guest || roles.length === 0) return null;

  const toggle = async (roleId: string, on: boolean) => {
    setError(undefined);
    setPending((p) => ({ ...p, [roleId]: on }));
    try {
      await (on ? client.addMyRole(roleId) : client.removeMyRole(roleId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(({ [roleId]: _, ...rest }) => rest);
    }
  };

  return (
    <section aria-labelledby="pick-roles" className="grid gap-3">
      <h2 id="pick-roles" className="text-lg font-semibold">Pick your roles</h2>
      {gated && <p className="text-sm text-muted-foreground">Accept the rules to pick roles.</p>}
      <ul className="grid gap-2">
        {roles.map((r) => (
          <RoleRow key={r.id} role={r} checked={pending[r.id] ?? held.includes(r.id)} disabled={gated || r.id in pending}
            onChange={(on) => void toggle(r.id, on)} />
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  );
}

function RoleRow({ role, checked, disabled, onChange }: {
  role: Parameters<typeof RoleIcon>[0]["role"]; checked: boolean; disabled: boolean; onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-semibold" style={role.color ? { color: role.color } : undefined}>
          <RoleIcon role={role} className="size-4 text-sm" />{role.name}
        </span>
        {role.description && <span className="block text-sm text-muted-foreground">{role.description}</span>}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </li>
  );
}
