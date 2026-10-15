import { hasPerm, Perm, SELF_ASSIGN_POWER, unwrap, type Member, type Role } from "@datrope/core";
import { Lock, TriangleAlert, X } from "@/components/icons";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useId, useMemo, useState, type CSSProperties } from "react";
import { ErrorText } from "@/components/error-text";
import { FormField } from "@/components/form-field";
import { UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubmit } from "@/hooks/use-submit";
import { canManageRole, myRank, outranks } from "@/lib/hierarchy";
import { ROLE_COLORS } from "@/lib/palettes";
import { cn } from "@/lib/utils";
import { PERM_GROUPS, PERM_LABELS } from "@/permLabels";
import { selfAssignBlocker } from "./selfAssign";
import { client, displayName, useApp } from "@/session";
import { EmojiPicker, reactionKey } from "@/chat/EmojiPicker";
import { RefButton } from "@/components/ref-button";
import { RoleIcon } from "@/components/role-icon";

/** Names for ROLE_COLORS, in the same order. */
const COLOR_NAMES = ["Red", "Orange", "Green", "Teal", "Blue", "Purple", "Pink", "Grey"];
const LABELS = new Map(PERM_LABELS.map((p) => [p.flag, p]));
const ADMIN_WARNING = "Administrator overrides every other setting, including channel permissions. Give it only to people you trust completely.";

type Color = NonNullable<Role["color"]>;
interface Edits {
  name?: string;
  color?: Color | null; // null = no colour
  hoist?: boolean;
  permissions?: number;
  selfAssignable?: boolean;
  mentionable?: boolean;
  description?: string;
}

interface Props {
  role: Role;
  everyone: boolean;
  rank: number;
  perms: number;
  onDeleted: () => void;
}

/** One role: Display, Permissions and Members tabs, with a save bar for unsaved Display and Permissions changes. */
export function RoleEditor({ role, everyone, rank, perms, onDeleted }: Props) {
  const [tab, setTab] = useState(everyone ? "permissions" : "display");
  const [edits, setEdits] = useState<Edits>({});
  const [deleting, setDeleting] = useState(false);
  const { busy, error, run } = useSubmit();

  // Only the permissions of @everyone can change, by anyone with MANAGE_ROLES who holds all of them.
  const editable = everyone ? hasPerm(perms, Perm.ManageRoles | role.permissions) : canManageRole(rank, perms, role);
  const name = edits.name ?? role.name;
  const color = edits.color === undefined ? role.color : edits.color ?? undefined;
  const hoist = edits.hoist ?? role.hoist;
  const permissions = edits.permissions ?? role.permissions;
  const selfAssignable = edits.selfAssignable ?? role.self_assignable;
  const mentionable = edits.mentionable ?? role.mentionable;
  const description = edits.description ?? role.description;
  const blocker = selfAssignBlocker(role, everyone, permissions);
  const changed = {
    name: name.trim() !== role.name,
    color: color !== role.color,
    hoist: hoist !== role.hoist,
    permissions: permissions !== role.permissions,
    selfAssignable: selfAssignable !== role.self_assignable,
    mentionable: mentionable !== role.mentionable,
    description: description.trim() !== role.description,
  };
  const dirty = Object.values(changed).some(Boolean);
  const edit = (e: Edits) => setEdits((x) => ({ ...x, ...e }));

  const save = () => void run(async () => {
    const body = everyone ? { permissions } : {
      ...(changed.name && { name: name.trim() }),
      ...(changed.permissions && { permissions }),
      ...(changed.hoist && { hoist }),
      ...(changed.selfAssignable && { self_assignable: selfAssignable }),
      ...(changed.mentionable && { mentionable }),
      ...(changed.description && { description: description.trim() }),
      ...(changed.color && (color ? { color } : { clear_color: true })),
    };
    client.apply("ROLE_UPDATE", await unwrap(client.api.PATCH("/api/server/roles/{roleID}", {
      params: { path: { roleID: role.id } }, body,
    })));
    setEdits({});
  });

  const remove = () => void run(async () => {
    await unwrap(client.api.DELETE("/api/server/roles/{roleID}", { params: { path: { roleID: role.id } } }));
    client.apply("ROLE_DELETE", { id: role.id });
    setDeleting(false);
    onDeleted();
  });

  return (
    <section aria-label={`Edit ${role.name}`} className="grid min-w-0 flex-[2_1_420px] gap-4">
      {!editable && (
        <p className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
          <Lock className="size-4 flex-none" aria-hidden />
          {everyone ? "You can only change @everyone if you have every permission it grants." : "You can only edit roles below your highest role."}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="display">Display</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          {!everyone && <TabsTrigger value="members">Members</TabsTrigger>}
        </TabsList>

        <TabsContent value="display" className="grid gap-5 pt-3">
          {everyone ? (
            <p className="text-muted-foreground">Every member has @everyone. It cannot be renamed, coloured or shown separately.</p>
          ) : (
            <>
              <FormField label="Role name" value={name} maxLength={32} required disabled={!editable}
                onChange={(e) => edit({ name: e.target.value })} />
              <ColorPicker value={color} disabled={!editable} onChange={(c) => edit({ color: c })} />
              <RoleIconField role={role} disabled={!editable} />
              <SwitchRow label="Show members separately" description="Members with this role get their own group in the member list."
                checked={hoist} disabled={!editable} onChange={(v) => edit({ hoist: v })} />
              <SwitchRow label="Mentionable by anyone" description="Anyone can ping this role with @role. Members with Mention any role can always ping it."
                checked={mentionable} disabled={!editable} onChange={(v) => edit({ mentionable: v })} />
              <SwitchRow label="Self-assignable" description={blocker ?? "Members can give themselves this role on the welcome page."}
                checked={selfAssignable && !blocker} disabled={!editable || !!blocker} onChange={(v) => edit({ selfAssignable: v })} />
              <FormField label="Description" value={description} maxLength={120} disabled={!editable}
                hint="Shown next to the role on the welcome page."
                onChange={(e) => edit({ description: e.target.value })} />
              {role.is_guest && (
                <p className="text-muted-foreground">
                  System role for guests — can't be deleted. Guests also have @everyone's permissions, so to keep them out of a channel, deny this role in that channel's permissions.
                </p>
              )}
              {editable && !role.is_guest && (
                <div>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={() => setDeleting(true)}>Delete role</Button>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="permissions" className="grid gap-4 pt-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">Permissions</span>
            {" · "}{role.name} has {PERM_LABELS.filter((p) => hasPerm(permissions, p.flag)).length} of {PERM_LABELS.length}
          </p>
          {PERM_GROUPS.map((g) => (
            <div key={g.title} className="grid">
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.title}</h4>
              {g.flags.map((flag) => {
                const p = LABELS.get(flag)!;
                const locked = selfAssignable && (flag & SELF_ASSIGN_POWER) !== 0 && !hasPerm(permissions, flag);
                return (
                  <SwitchRow key={flag} label={p.label} description={p.description} checked={hasPerm(permissions, flag)}
                    disabled={!editable || locked} lacking={editable && !hasPerm(perms, flag)} separated
                    warning={flag === Perm.Admin ? ADMIN_WARNING : locked ? "Turn off Self-assignable to grant this." : undefined}
                    onChange={(v) => edit({ permissions: v ? permissions | flag : permissions & ~flag })} />
                );
              })}
            </div>
          ))}
          {editable && PERM_LABELS.some((p) => !hasPerm(perms, p.flag)) && (
            <p className="m-0 text-xs text-muted-foreground pointer-fine:hidden">You can only grant permissions you have.</p>
          )}
        </TabsContent>

        {!everyone && (
          <TabsContent value="members" className="pt-3">
            <RoleMembers role={role} rank={rank} editable={editable} />
          </TabsContent>
        )}
      </Tabs>

      <ErrorText error={error} />

      {dirty && editable && (
        <div role="region" aria-label="Unsaved changes"
          className="sticky bottom-safe flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 shadow-lg">
          <span className="min-w-0 flex-1">You have unsaved changes.</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setEdits({})}>Reset</Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={save}>Save</Button>
        </div>
      )}

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Delete ${role.name}?`}</DialogTitle>
            <DialogDescription>Everyone who has this role loses it. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <ErrorText error={error} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={remove}>Delete role</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ColorPicker({ value, disabled, onChange }: { value?: string; disabled: boolean; onChange: (c: Color | null) => void }) {
  const id = useId();
  const swatch = "size-8 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:ring-2 data-[state=checked]:ring-foreground data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-background";
  return (
    <div className="grid gap-2">
      <span id={id} className="text-sm font-medium">Colour</span>
      <RadioGroup aria-labelledby={id} value={value ?? "none"} disabled={disabled}
        onValueChange={(v) => onChange(v === "none" ? null : (v as Color))} className="flex flex-wrap gap-2">
        <RadioGroupPrimitive.Item value="none" aria-label="None"
          className={cn(swatch, "grid place-items-center border border-dashed text-muted-foreground")}>
          <X className="size-4" aria-hidden />
        </RadioGroupPrimitive.Item>
        {ROLE_COLORS.map((c, i) => (
          <RadioGroupPrimitive.Item key={c} value={c} aria-label={COLOR_NAMES[i]}
            style={{ "--swatch": c } as CSSProperties} className={cn(swatch, "bg-[var(--swatch)]")} />
        ))}
      </RadioGroup>
    </div>
  );
}

interface SwitchRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  lacking?: boolean; // the role is editable, but I do not hold this permission
  separated?: boolean;
  warning?: string;
  onChange: (v: boolean) => void;
}

function SwitchRow({ label, description, checked, disabled, lacking, separated, warning, onChange }: SwitchRowProps) {
  const id = useId();
  // A disabled control swallows pointer events, so the tooltip listens on a wrapper instead.
  const toggle = <Switch id={id} checked={checked} disabled={disabled || lacking} onCheckedChange={onChange}
    className={cn(lacking && "pointer-events-none")} />;
  return (
    <div className={cn("flex items-center gap-3", separated ? "border-t py-2.5" : "rounded-lg border p-3")}>
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
        {warning && (
          <span className="mt-1 flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 flex-none" aria-hidden />{warning}
          </span>
        )}
      </label>
      {lacking ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">{toggle}</span>
          </TooltipTrigger>
          <TooltipContent>You can only grant permissions you have</TooltipContent>
        </Tooltip>
      ) : toggle}
    </div>
  );
}

/** Members holding the role, with add (picker) and remove. These apply at once. */
function RoleMembers({ role, rank, editable }: { role: Role; rank: number; editable: boolean }) {
  const sv = useApp((s) => s.server);
  const meId = useApp((s) => s.me?.id);
  const [picking, setPicking] = useState(false);
  const { busy, error, run } = useSubmit();

  const { holders, others, canAssign } = useMemo(() => {
    const roles = Object.values(sv?.roles ?? {});
    const all = Object.values(sv?.members ?? {}).sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
    const canAssign = (m: Member) => editable && !!sv &&
      (m.user.id === meId || outranks(rank, myRank(sv.server, roles, m.user.id, m.role_ids ?? [])));
    const has = (m: Member) => (m.role_ids ?? []).includes(role.id);
    return { holders: all.filter(has), others: all.filter((m) => !has(m) && canAssign(m)), canAssign };
  }, [sv, meId, rank, editable, role.id]);

  const removeFrom = (m: Member) => void run(async () => {
    await unwrap(client.api.DELETE("/api/server/members/{userID}/roles/{roleID}", {
      params: { path: { userID: m.user.id, roleID: role.id } },
    }));
  });

  return (
    <div className="grid gap-3">
      {editable && (
        <div>
          <Button size="sm" variant="outline" disabled={others.length === 0} onClick={() => setPicking(true)}>Add members</Button>
        </div>
      )}
      <ErrorText error={error} />
      {holders.length === 0 ? <p className="text-muted-foreground">Nobody has this role yet.</p> : (
        <ul aria-label={`Members with ${role.name}`} className="grid">
          {holders.map((m) => (
            <li key={m.user.id} className="flex items-center gap-3 border-t py-2">
              <MemberName m={m} />
              {canAssign(m) && (
                <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${role.name} from ${displayName(m.user)}`}
                  onClick={() => removeFrom(m)}>Remove</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {picking && <AddMembers role={role} candidates={others} onClose={() => setPicking(false)} />}
    </div>
  );
}

function MemberName({ m }: { m: Member }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <UserAvatar user={m.user} size="md" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{displayName(m.user)}</span>
        <span className="block truncate text-sm text-muted-foreground">@{m.user.username}</span>
      </span>
    </span>
  );
}

function AddMembers({ role, candidates, onClose }: { role: Role; candidates: Member[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useSubmit();
  const q = query.trim().toLowerCase();
  const shown = candidates.filter((m) => !q || displayName(m.user).toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q));

  const add = () => void run(async () => {
    for (const userID of picked) {
      await unwrap(client.api.PUT("/api/server/members/{userID}/roles/{roleID}", { params: { path: { userID, roleID: role.id } } }));
      setPicked((p) => p.filter((x) => x !== userID)); // a retry after a failure skips those already added
    }
    onClose();
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Add members to ${role.name}`}</DialogTitle>
          <DialogDescription>Only people below you in the role order are listed.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Search members" placeholder="Search members" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul className="grid max-h-72 overflow-y-auto">
          {shown.map((m) => {
            const id = `add-${m.user.id}`;
            return (
              <li key={m.user.id} className="flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-accent">
                <Checkbox id={id} checked={picked.includes(m.user.id)} onCheckedChange={(v) =>
                  setPicked((p) => (v ? [...p, m.user.id] : p.filter((x) => x !== m.user.id)))} />
                <label htmlFor={id} className="flex min-w-0 flex-1"><MemberName m={m} /></label>
              </li>
            );
          })}
          {shown.length === 0 && <li className="py-2 text-muted-foreground">Nobody matches.</li>}
        </ul>
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || picked.length === 0} onClick={add}>
            {picked.length > 1 ? `Add ${picked.length} members` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ICON_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** The role's icon, shown next to its members' names: an emoji or a small image. Changes apply at once. */
function RoleIconField({ role, disabled }: { role: Role; disabled: boolean }) {
  const { busy, error, run } = useSubmit();
  const fileId = useId();
  const has = !!(role.icon_emoji || role.icon_url);
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">Role icon</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-9 place-items-center rounded-md border bg-card" aria-label={has ? "Current icon" : "No icon"} role="img">
          <RoleIcon role={role} className="size-6 text-xl" />
        </span>
        <EmojiPicker onPick={(v) => void run(async () => { await client.setRoleIconEmoji(role.id, reactionKey(v)); })}
          trigger={<RefButton variant="outline" size="sm" disabled={disabled || busy}>Choose emoji</RefButton>} />
        <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => document.getElementById(fileId)?.click()}>Upload image</Button>
        {has && <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => void run(async () => { await client.removeRoleIcon(role.id); })}>Remove</Button>}
        <input id={fileId} type="file" hidden accept={ICON_TYPES} aria-label="Choose a role icon image" onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(async () => { await client.uploadRoleIcon(role.id, f); });
        }} />
      </div>
      <span className="text-xs text-muted-foreground">Shown next to the names of members whose highest icon role this is. Images: PNG, JPEG, WebP or GIF, up to 256 KB and 512 × 512 pixels.</span>
      <ErrorText error={error} />
    </div>
  );
}
