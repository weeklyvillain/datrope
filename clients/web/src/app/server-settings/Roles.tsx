import { Perm, hasPerm, rolesByRank, unwrap, type Role } from "@datrope/core";
import { ArrowLeft, ChevronDown, ChevronUp, Lock, Plus } from "@/components/icons";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSubmit } from "@/hooks/use-submit";
import { canManageRole } from "@/lib/hierarchy";
import { cn } from "@/lib/utils";
import { client, useApp, useMyRank, usePerms } from "@/session";
import { RoleEditor } from "./RoleEditor";
import { BareButton } from "@/components/bare-button";

/** Roles (MANAGE_ROLES): the list, highest first, and the editor for the selected role. */
export function Roles() {
  const roles = useApp(useShallow(rolesByRank));
  const everyoneId = useApp((s) => s.server?.server.id);
  const members = useApp((s) => s.server?.members);
  const isOwner = useApp((s) => !!s.me && s.me.id === s.server?.server.owner_id);
  const rank = useMyRank();
  const perms = usePerms();
  const phone = useIsMobile();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [chosen, setChosen] = useState<string>();
  // Phones show the list or the editor, never both: the open role lives in `?role=` so Back returns to the list.
  const selected = phone ? params.get("role") ?? undefined : chosen;
  const setSelected = (id: string | undefined) => {
    if (!phone) return setChosen(id);
    if (id) setParams({ role: id }, { state: { fromList: true } });
    else setParams({}, { replace: true });
  };
  const backToList = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else setParams({}, { replace: true });
  };
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    client.loadMembers().catch(() => {}); // READY already brought members; this only refreshes them
  }, []);

  const role = roles.find((r) => r.id === selected) ?? (phone ? undefined : roles[0]);
  const top = roles[0]?.position ?? 0;
  const count = (r: Role) => Object.values(members ?? {}).filter((m) => (m.role_ids ?? []).includes(r.id)).length;

  const create = () => void run(async () => {
    const r = await unwrap(client.api.POST("/api/server/roles", { body: { name: "New role", permissions: 0 } }));
    client.apply("ROLE_CREATE", r);
    setSelected(r.id);
  });
  const move = (r: Role, position: number) => void run(async () => {
    client.apply("ROLE_UPDATE", await unwrap(client.api.PATCH("/api/server/roles/{roleID}", {
      params: { path: { roleID: r.id } }, body: { position },
    })));
  });

  return (
    <>
      {phone && role ? (
        <>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Back to roles" onClick={backToList}><ArrowLeft /></Button>
            <h3 className="min-w-0 flex-1 truncate font-semibold">{role.name}</h3>
          </div>
          <RoleEditor key={role.id} role={role} everyone={role.id === everyoneId} rank={rank} perms={perms}
            onDeleted={() => setSelected(undefined)} />
        </>
      ) : (
      <>
      <p className="max-w-[68ch] text-muted-foreground">
        Roles group people and decide what they may do. Everyone has @everyone; give extra roles for more.
      </p>
      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Roles" className="grid flex-[1_1_260px] gap-0.5 rounded-xl border bg-card p-2 sm:max-w-[340px]">
          <span className="px-2 pt-1 pb-2 text-sm text-muted-foreground">Higher roles win.</span>
          {roles.map((r) => {
            const everyone = r.id === everyoneId;
            const editable = everyone ? hasPerm(perms, r.permissions) : canManageRole(rank, perms, r);
            const movable = !everyone && canManageRole(rank, perms, r); // the server checks the role's permissions on moves too
            const n = count(r);
            return (
              <div key={r.id} className={cn("flex items-center rounded-md hover:bg-accent", r.id === role?.id && "bg-accent")}>
                <BareButton aria-pressed={r.id === role?.id} onClick={() => setSelected(r.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2.5 pointer-coarse:min-h-[44px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span aria-hidden className={cn("size-3 flex-none rounded-full", !r.color && "bg-muted-foreground")}
                    style={r.color ? { background: r.color } : undefined} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
                  {!editable && <Lock className="size-3.5 flex-none text-muted-foreground" aria-label="Read only" />}
                  <span className="flex-none text-sm text-muted-foreground">
                    {everyone ? "All members" : `${n} ${n === 1 ? "member" : "members"}`}
                  </span>
                </BareButton>
                {movable && (
                  <span className="flex flex-none pr-1">
                    <Button variant="ghost" size="icon-xs" aria-label={`Move ${r.name} up`}
                      disabled={busy || r.position >= top || r.position + 1 >= rank} onClick={() => move(r, r.position + 1)}>
                      <ChevronUp />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Move ${r.name} down`}
                      disabled={busy || r.position <= 1} onClick={() => move(r, r.position - 1)}>
                      <ChevronDown />
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
          {hasPerm(perms, Perm.ManageRoles) && (isOwner || rank >= 1) && (
            <BareButton disabled={busy} onClick={create}
              className="mt-1 flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 pointer-coarse:min-h-[44px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <Plus className="size-4" aria-hidden />Create role
            </BareButton>
          )}
          <ErrorText error={error} />
        </section>
        {role && !phone && (
          <RoleEditor key={role.id} role={role} everyone={role.id === everyoneId} rank={rank} perms={perms}
            onDeleted={() => setSelected(undefined)} />
        )}
      </div>
      </>
      )}
    </>
  );
}
