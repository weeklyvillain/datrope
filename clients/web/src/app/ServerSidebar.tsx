import { Perm, canCreateInvites, hasPerm, isGated } from "@datrope/core";
import { ChevronDown, FolderPlus, Images, Plus, Settings, UserPlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useMatch, useNavigate } from "react-router-dom";
import { ServerIcon } from "@/components/logo";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isUnread, lastVisited, rememberVisit, useApp, usePerms } from "../session";
import { DMList } from "./DMList";
import { SidebarFooter } from "./SidebarFooter";
import { CategoryDialog } from "./dialogs/CategoryDialog";
import { CreateChannelDialog } from "./dialogs/CreateChannelDialog";
import { InviteDialog } from "./dialogs/InviteDialog";
import { ChannelTree } from "./sidebar/ChannelTree";

export const SETTINGS_PERMS = [Perm.ManageServer, Perm.ManageRoles, Perm.Kick, Perm.Ban, Perm.ManageChannels];
const TAB = "h-8 data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:shadow-none";

/** The left column: server header, Channels / Messages tabs, voice panel and profile strip. */
export function ServerSidebar({ className }: { className?: string } = {}) {
  const nav = useNavigate();
  const channelId = useMatch("/channels/:channelId")?.params.channelId;
  const dmId = useMatch("/messages/:channelId")?.params.channelId;
  const inMessages = !!useMatch("/messages/*");
  const onGallery = !!useMatch("/gallery/*");
  const gated = useApp(isGated);
  const dmUnread = useApp((s) => s.dmIds.some((id) => isUnread(s.readStates[id])));
  const dmIds = useApp((s) => s.dmIds);

  const channelType = useApp((s) => (channelId ? s.channels[channelId]?.type : undefined));
  useEffect(() => {
    if (channelId) rememberVisit("channel", channelId);
  }, [channelId]);
  useEffect(() => {
    if (channelId && channelType && channelType !== "voice") rememberVisit("text", channelId);
  }, [channelId, channelType]);
  useEffect(() => {
    if (dmId) rememberVisit("dm", dmId);
  }, [dmId]);

  const tab = inMessages ? "messages" : "channels";
  const switchTab = (to: string) => {
    if (to === "channels") {
      nav("/"); // Home opens the last channel visited, else the first text channel
    } else {
      const last = lastVisited("dm");
      nav(last && dmIds.includes(last) ? `/messages/${last}` : "/messages");
    }
  };

  return (
    <nav className={cn("flex w-60 flex-none flex-col border-r bg-sidebar", className)} aria-label={tab === "messages" ? "Direct messages" : "Channels"}>
      <ServerHeader />
      <Tabs value={tab} onValueChange={switchTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="grid h-auto w-auto grid-cols-2 gap-1 bg-transparent px-2 pt-2 pb-0">
          <TabsTrigger value="channels" className={TAB}>Channels</TabsTrigger>
          <TabsTrigger value="messages" disabled={gated} className={TAB}>
            Messages
            {dmUnread && (
              <>
                <span className="size-2 rounded-full bg-foreground" aria-hidden />
                <span className="sr-only">(unread)</span>
              </>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="channels" className="min-h-0 overflow-y-auto">
          <Link to="/gallery" aria-current={onGallery ? "page" : undefined}
            className={cn("mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground no-underline hover:bg-accent hover:text-foreground",
              onGallery && "bg-accent text-foreground")}>
            <Images className="size-4" aria-hidden />Gallery
          </Link>
          <CreateMenu>
            <ChannelTree activeId={channelId} />
          </CreateMenu>
        </TabsContent>
        <TabsContent value="messages" className="flex min-h-0 flex-col">
          <DMList activeId={dmId} />
        </TabsContent>
      </Tabs>
      <SidebarFooter />
    </nav>
  );
}

/** Right-click on the channel list: create a channel or category. Channel and category rows keep their own menus. */
function CreateMenu({ children }: { children: ReactNode }) {
  const canCreate = hasPerm(usePerms(), Perm.ManageChannels);
  const [dialog, setDialog] = useState<"create" | "category">();
  if (!canCreate) return <>{children}</>;
  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <div className="min-h-full">{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenuItem onSelect={() => setDialog("create")}><Plus />Create channel</ContextMenuItem>
          <ContextMenuItem onSelect={() => setDialog("category")}><FolderPlus />Create category</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {dialog === "create" && <CreateChannelDialog onClose={() => setDialog(undefined)} />}
      {dialog === "category" && <CategoryDialog onClose={() => setDialog(undefined)} />}
    </>
  );
}

function ServerHeader() {
  const nav = useNavigate();
  const sv = useApp((s) => s.server?.server);
  const count = useApp((s) => Object.keys(s.server?.members ?? {}).length);
  const perms = usePerms();
  const isAdmin = useApp((s) => !!s.me?.is_admin);
  const canInvite = useApp(canCreateInvites);
  const [dialog, setDialog] = useState<"invite" | "create" | "category">();
  if (!sv) return null;
  const canSettings = isAdmin || SETTINGS_PERMS.some((p) => hasPerm(perms, p)); // instance admins reach Sign-ups and Uploads
  const canCreate = hasPerm(perms, Perm.ManageChannels);
  const header = "flex h-14 w-full flex-none items-center gap-2.5 border-b px-3.5 text-left text-foreground";
  const content = (
    <>
      <ServerIcon size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{sv.name}</span>
        {/* Gated members get no member list, so no count. */}
        {count > 0 && <span className="block text-xs text-muted-foreground">{count} {count === 1 ? "member" : "members"}</span>}
      </span>
    </>
  );
  if (!canInvite && !canSettings && !canCreate) return <div className={header}>{content}</div>;
  return (
    <>
      <div className="flex h-14 flex-none items-center border-b">
        {/* Not modal: its items open dialogs, which a modal menu would fight for focus. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger aria-label={`${sv.name} menu`}
            className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3.5 text-left text-foreground outline-none hover:bg-accent focus-visible:bg-accent">
            {content}
            <ChevronDown className="size-4 flex-none text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {canInvite && <DropdownMenuItem onSelect={() => setDialog("invite")}><UserPlus />Invite people</DropdownMenuItem>}
            {canSettings && <DropdownMenuItem onSelect={() => nav("/server-settings")}><Settings />Server settings</DropdownMenuItem>}
            {canCreate && <DropdownMenuItem onSelect={() => setDialog("create")}><Plus />Create channel</DropdownMenuItem>}
            {canCreate && <DropdownMenuItem onSelect={() => setDialog("category")}><FolderPlus />Create category</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        {canSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex px-1.5">
                <Button variant="ghost" size="icon-sm" aria-label="Server settings" className="text-muted-foreground hover:text-foreground"
                  onClick={() => nav("/server-settings")}>
                  <Settings />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Server settings</TooltipContent>
          </Tooltip>
        )}
      </div>
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(undefined)} />}
      {dialog === "create" && <CreateChannelDialog onClose={() => setDialog(undefined)} />}
      {dialog === "category" && <CategoryDialog onClose={() => setDialog(undefined)} />}
    </>
  );
}
