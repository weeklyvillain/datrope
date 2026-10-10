import type { PublicUser, Role } from "@datrope/core";
import { useState, type ReactNode } from "react";
import { ErrorText } from "@/components/error-text";
import { useNavigate } from "react-router-dom";
import { RoleBadge } from "@/components/role-badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { UserAvatar } from "@/components/user-avatar";
import { useUser } from "@/hooks/use-user";
import { avatarColor } from "@/lib/avatar-color";
import { isHttpsLink } from "@/lib/social";
import { cn } from "@/lib/utils";
import { client, displayName, errorText, roleColor, useApp } from "@/session";
import { openProfile } from "../side-panel/panel";
import { openSettings } from "../settings/settings-store";
import { ProfileLinks } from "./ProfileLinks";
import { useAssignableRoles } from "./use-assignable-roles";

const joined = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

const sec = "mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

/** A person's profile: banner, avatar, names, status, about me, roles and actions. `preview` overrides fields and hides the actions. */
export function ProfileCard({ userId, variant, preview, fallback, onAction, roleAction, rolesFooter }: {
  userId: string;
  variant: "popover" | "panel";
  preview?: Partial<PublicUser>;
  fallback?: PublicUser;
  onAction?: () => void;
  /** Shown after each role badge (the panel's remove button) and at the end of the roles list (its add button). */
  roleAction?: (role: Role) => ReactNode;
  rolesFooter?: ReactNode;
}) {
  const stored = useUser(userId, fallback);
  const user = stored ? { ...stored, ...preview } : undefined;
  const navigate = useNavigate();
  const sv = useApp((s) => s.server);
  const member = useApp((s) => s.server?.members[userId]);
  const presence = useApp((s) => s.presences[userId] ?? "offline");
  const isMe = useApp((s) => s.me?.id === userId);
  const voiceName = useApp((s) => {
    const id = s.voice[userId]?.channel_id;
    const ch = id ? s.channels[id] : undefined;
    return !ch ? undefined : ch.type === "dm" ? null : ch.name;
  });
  const { held } = useAssignableRoles(userId);
  const [error, setError] = useState<string>();
  if (!user) return <p className="m-0 p-4 text-sm text-muted-foreground">This person is not available.</p>;
  const panel = variant === "panel";
  const name = displayName(user);
  const sub = user.pronouns ? `${user.username} · ${user.pronouns}` : user.username;

  // The popover stays open on a failure, so the error shows.
  const message = () => {
    setError(undefined);
    client.openDM(userId).then((ch) => {
      onAction?.();
      navigate(`/messages/${ch.id}`);
    }, (e: unknown) => setError(errorText(e)));
  };
  const actions = preview ? null : isMe
    ? <Button size="sm" variant={panel ? "default" : "outline"} className={cn(!panel && "flex-1")} onClick={() => { onAction?.(); openSettings("profile"); }}>Edit profile</Button>
    : <Button size="sm" className={cn(!panel && "flex-1")} onClick={message}>Message</Button>;

  return (
    <div>
      <div className={cn("overflow-hidden", panel ? "h-24" : "h-16")} style={{ background: roleColor(sv, userId) ?? avatarColor(userId) }}>
        {user.banner_url && <img src={client.url(user.banner_url)} alt="" className="size-full object-cover" />}
      </div>
      <div className={cn("pb-4", panel ? "px-5" : "px-4")}>
        <div className="-mt-10 w-fit">
          <UserAvatar user={user} size="xl" status={presence} ringClassName={panel ? "ring-card" : "ring-popover"}
            className={cn("ring-4", panel ? "ring-card" : "ring-popover")} />
        </div>
        <div className="mt-2 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <div className={cn("truncate font-bold text-foreground", panel ? "text-[20px]" : "text-[18px]")}>{name}</div>
            <div className="truncate text-sm text-muted-foreground">{sub}</div>
          </div>
          {panel && actions}
        </div>
        {user.custom_status && <p className="mt-2 text-sm">{user.custom_status}</p>}
        {panel && voiceName !== undefined && (
          <p className="mt-2 text-sm">{voiceName === null ? "In a call" : <><span className="text-muted-foreground">In voice:</span> {voiceName}</>}</p>
        )}
        <Separator className="my-3" />
        {user.about_me && (
          <section className="mb-3">
            <h3 className={sec}>About me</h3>
            <p className="m-0 whitespace-pre-wrap text-sm wrap-anywhere">{user.about_me}</p>
          </section>
        )}
        {user.links?.some(isHttpsLink) && (
          <section className="mb-3">
            <h3 className={sec}>Links</h3>
            <ProfileLinks links={user.links} />
          </section>
        )}
        {(held.length > 0 || rolesFooter) && (
          <section className="mb-3">
            <h3 className={sec}>Roles</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {held.map((r) => (
                <span key={r.id} className="inline-flex items-center gap-0.5"><RoleBadge role={r} />{roleAction?.(r)}</span>
              ))}
              {rolesFooter}
            </div>
          </section>
        )}
        {member && (
          <section className={cn(!panel && actions ? "mb-3.5" : undefined)}>
            <h3 className={sec}>Member since</h3>
            <p className="m-0 text-sm">{joined.format(new Date(member.joined_at))}</p>
          </section>
        )}
        <ErrorText error={error} />
        {!panel && actions && (
          <div className="flex gap-2">
            {actions}
            <Button size="sm" variant="outline" onClick={() => { onAction?.(); openProfile(userId); }}>View full profile</Button>
          </div>
        )}
      </div>
    </div>
  );
}
