import { unwrap, type Role } from "@datrope/core";
import { Plus, UserRound, X } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RoleBadge } from "@/components/role-badge";
import { useSubmit } from "@/hooks/use-submit";
import { client } from "@/session";
import { SidePanel } from "../side-panel/SidePanel";
import { ProfileCard } from "./ProfileCard";
import { useAssignableRoles } from "./use-assignable-roles";

/** The full profile in the side panel, with quick role add and remove for people who may manage them. */
export function ProfilePanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { addable, removable, canEdit } = useAssignableRoles(userId);
  const { busy, error, run } = useSubmit();
  const change = (r: Role, add: boolean) => void run(async () => {
    const opts = { params: { path: { userID: userId, roleID: r.id } } };
    await unwrap(add
      ? client.api.PUT("/api/server/members/{userID}/roles/{roleID}", opts)
      : client.api.DELETE("/api/server/members/{userID}/roles/{roleID}", opts));
  });
  return (
    <SidePanel title="Profile" icon={<UserRound />} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProfileCard userId={userId} variant="panel"
          roleAction={canEdit ? (r) => removable.includes(r) && (
            <Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" disabled={busy}
              aria-label={`Remove role ${r.name}`} onClick={() => change(r, false)}>
              <X />
            </Button>
          ) : undefined}
          rolesFooter={canEdit && (addable.length > 0 || error) ? (
            <>
              {addable.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <RefButton variant="outline" size="xs" className="rounded-full border-dashed text-muted-foreground" aria-label="Add role" disabled={busy}>
                      <Plus /> Add role
                    </RefButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {addable.map((r) => <DropdownMenuItem key={r.id} onSelect={() => change(r, true)}><RoleBadge role={r} /></DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <div className="basis-full empty:hidden"><ErrorText error={error} /></div>
            </>
          ) : undefined} />
      </div>
    </SidePanel>
  );
}
