import { Perm, hasPerm, isGated, sidebarChannelIds } from "@datrope/core";
import { BookOpen, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ErrorText } from "@/components/error-text";
import { ServerIcon } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/hooks/use-submit";
import { client, errorText, useApp, usePerms } from "@/session";
import { TopBar } from "../TopBar";
import { SearchPanel } from "../search/SearchPanel";
import { usePanel } from "../side-panel/panel";
import { WelcomeEditor } from "./WelcomeEditor";
import { WelcomeMarkdown } from "./WelcomeMarkdown";

/** The welcome channel: banner, server name and description, the page, and the rules gate. */
export function WelcomeView({ channelId }: { channelId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  const welcome = useApp((s) => s.welcome);
  const gated = useApp(isGated);
  const canEdit = hasPerm(usePerms(), Perm.ManageServer);
  // Server settings → Welcome page opens the editor directly.
  const openEditor = (useLocation().state as { edit?: boolean } | null)?.edit === true;
  const [editing, setEditing] = useState(openEditor);
  const [loadError, setLoadError] = useState<string>();
  const nav = useNavigate();
  const searching = usePanel((s) => s.panel?.kind === "search");

  // Load the page, and again if a fresh READY cleared it; WELCOME_UPDATE keeps it current.
  useEffect(() => {
    if (!welcome) client.loadWelcome().catch((e) => setLoadError(errorText(e)));
  }, [welcome]);

  // Once the gate lifts (rules accepted here or in another tab), go to the first text channel.
  // Not "/": Home would reopen the last channel visited, which is this one. The gate can lift
  // before the READY that brings the other channels, so wait for a text channel to appear.
  const firstText = useApp((s) => sidebarChannelIds(s).find((id) => s.channels[id]?.type === "text"));
  const wasGated = useRef(gated);
  const lifted = useRef(false);
  useEffect(() => {
    if (wasGated.current && !gated) lifted.current = true;
    wasGated.current = gated;
    if (lifted.current && !gated && firstText) nav(`/channels/${firstText}`, { replace: true });
  }, [gated, firstText, nav]);

  if (editing && welcome && canEdit) return <WelcomeEditor welcome={welcome} onClose={() => setEditing(false)} />;

  const name = ch?.name ?? "welcome";
  const blank = !welcome?.markdown.trim();
  return (
    <>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={name}>
      <TopBar tools={!gated} actions={canEdit && welcome ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil />Edit page</Button> : undefined}>
        <BookOpen className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate">{name}</h2>
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Banner />
        <article className="mx-auto grid max-w-[760px] gap-6 px-8 pb-12">
          <ServerHeading />
          {loadError ? <ErrorText error={loadError} />
            : !welcome ? <p className="text-muted-foreground">Loading…</p>
            : !blank ? <WelcomeMarkdown markdown={welcome.markdown} />
            : canEdit ? (
              <div className="grid justify-items-center gap-3 rounded-lg border border-dashed p-8 text-center">
                <p className="font-semibold">This page is empty</p>
                <p className="max-w-[48ch] text-sm text-muted-foreground">Introduce the server, list the rules and point people to the right channels. New members land here first.</p>
                <Button onClick={() => setEditing(true)}><Pencil />Write the welcome page</Button>
              </div>
            ) : <p className="text-muted-foreground">Nothing here yet.</p>}
        </article>
      </div>
      {gated && <RulesGate />}
    </main>
    {!gated && searching && <SearchPanel />}
    </>
  );
}

/** The server banner, or a muted gradient when none is uploaded. */
function Banner() {
  const banner = useApp((s) => s.server?.server.banner_url);
  if (banner) return <img src={client.url(banner)} alt="" className="h-[200px] w-full object-cover" />;
  return <div className="h-[200px] bg-linear-to-br from-primary/25 via-muted to-background" aria-hidden />;
}

function ServerHeading() {
  const name = useApp((s) => s.server?.server.name);
  const description = useApp((s) => s.server?.server.description);
  return (
    <div className="-mt-10 flex items-end gap-4">
      <ServerIcon size={88} className="rounded-[22px] border-4 border-background bg-card" />
      <div className="min-w-0 pb-1.5">
        <h1 className="text-[1.75rem] font-bold">{name}</h1>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

/** Bar pinned below the page while the gate hides the rest of the server from me. */
function RulesGate() {
  const { busy, error, run } = useSubmit();
  return (
    <section aria-label="Accept the rules" className="flex-none border-t bg-card px-4 py-3">
      <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-4">
        <p className="min-w-0 flex-[1_1_280px] text-sm text-muted-foreground">Read the page above, then accept the rules to see the rest of the server.</p>
        <Button disabled={busy} onClick={() => void run(() => client.acceptRules())}>I accept the rules</Button>
      </div>
      <div className="mx-auto max-w-[760px]"><ErrorText error={error} /></div>
    </section>
  );
}
