import { unwrap, type Role } from "@datrope/core";
import { Plus, UserRound, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { RoleBadge } from "@/components/role-badge";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import { useTitleBarClass, useTitleBarEdges } from "@/hooks/use-title-bar-edges";
import { useSubmit } from "@/hooks/use-submit";
import { client } from "@/session";
import { closeProfile, panelStore, usePanel } from "../side-panel/panel";
import { ProfileCard } from "./ProfileCard";
import { useAssignableRoles } from "./use-assignable-roles";

/** Someone's full profile in a drawer from the right, over the page; the side panel underneath stays as it was. */
export function ProfileDrawer() {
  const userId = usePanel((s) => s.profile);
  const edges = useTitleBarEdges();
  const bandClass = useTitleBarClass("flex h-14 flex-none items-center gap-2 border-b pl-4 pr-2");
  useHistoryLayer("profile", !!userId, closeProfile);
  const shown = useRef(userId);
  if (userId) shown.current = userId; // keeps the profile in place while the drawer slides out
  // Its actions (Message, Edit profile) go to another page: the drawer must not stay over it.
  // Their navigate already replaced the layer's entry, so closing pops nothing.
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (panelStore.getState().profile) closeProfile();
  }, [pathname]);
  return (
    <Sheet open={!!userId} onOpenChange={(open) => !open && closeProfile()}>
      <SheetContent side="right" showCloseButton={false} aria-describedby={undefined}
        className="w-[400px] max-w-full gap-0 bg-card p-0 sm:max-w-[400px]">
        <header ref={edges} data-titlebar-drag className={bandClass}>
          <UserRound className="size-4 flex-none text-muted-foreground" aria-hidden />
          <SheetTitle className="min-w-0 flex-1 truncate text-body">Profile</SheetTitle>
          <SheetClose asChild>
            <RefButton variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Close profile" title="Close"><X /></RefButton>
          </SheetClose>
        </header>
        {shown.current && <ProfileBody key={shown.current} userId={shown.current} />}
      </SheetContent>
    </Sheet>
  );
}

/** The profile card, with quick role add and remove for people who may manage them. */
function ProfileBody({ userId }: { userId: string }) {
  const { addable, removable, canEdit } = useAssignableRoles(userId);
  const { busy, error, run } = useSubmit();
  const change = (r: Role, add: boolean) => void run(async () => {
    const opts = { params: { path: { userID: userId, roleID: r.id } } };
    await unwrap(add
      ? client.api.PUT("/api/server/members/{userID}/roles/{roleID}", opts)
      : client.api.DELETE("/api/server/members/{userID}/roles/{roleID}", opts));
  });
  return (
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
  );
}
