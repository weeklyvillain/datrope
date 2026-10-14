import { useEffect, useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AddServerDialog, AddServerForm } from "./AddServerDialog";
import {
  emptyRailState, listServers, onChromeRequest, onRailState, removeServer, setChromeMode, type ChromeMode, type RailState,
} from "./rail-api";
import { TopBar } from "./TopBar";

/**
 * The chrome webview: title bar and dialogs. The shell sizes it to the mode: just the bar (closed, and drawer, where
 * the drawer is its own webview over the server page) or the whole window (full).
 */
export function Chrome() {
  const [state, setState] = useState<RailState>(emptyRailState);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string>();
  const removing = state.servers.find((s) => s.id === removingId);

  useEffect(() => {
    void listServers().then(setState);
    const stopState = onRailState(setState);
    // The drawer asks for the dialogs; the shell has already given this webview the whole window.
    const stopRequests = onChromeRequest((action) => {
      if (action === "add") setAdding(true);
      else setRemovingId(action.remove);
    });
    return () => { stopState(); stopRequests(); };
  }, []);

  const empty = state.servers.length === 0 && state.mode === "full";
  const drawerOpen = state.mode === "drawer";

  function changeMode(mode: ChromeMode) {
    setState((s) => ({ ...s, mode: s.servers.length === 0 ? "full" : mode }));
    void setChromeMode(mode);
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") changeMode("closed"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function openAdd(open: boolean) {
    setAdding(open);
    changeMode(open ? "full" : "closed");
  }

  function confirmRemove(id: string | undefined) {
    setRemovingId(id);
    changeMode(id ? "full" : "closed");
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar state={state} drawerOpen={drawerOpen} onToggleDrawer={() => changeMode(drawerOpen ? "closed" : "drawer")} />

      {empty && (
        <main className="flex grow items-center justify-center bg-background p-6">
          <div className="grid w-full max-w-sm gap-4">
            <h1 className="m-0 text-xl font-semibold text-foreground">Add your first server</h1>
            <p className="m-0 text-sm text-muted-foreground">Enter the address of a Datrope server, like chat.example.com.</p>
            <AddServerForm onAdded={() => undefined} />
          </div>
        </main>
      )}

      <AddServerDialog open={adding} onOpenChange={openAdd} />

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && confirmRemove(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>You'll be signed out of this server on this device. You can add it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (removing) void removeServer(removing.id); setRemovingId(undefined); }}>
              Remove server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
