import { Menu } from "@tauri-apps/api/menu";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { moveId } from "./order";
import {
  emptyRailState, listServers, onRailState, reorderServers, requestChrome, selectServer, setChromeMode,
  type RailServer, type RailState,
} from "./rail-api";
import { ServerDrawer } from "./ServerDrawer";
import { applyTheme } from "./theme";
import "./rail.css";

/**
 * The drawer webview: the server list that slides in over the server page. The add and remove dialogs need the
 * whole window, so it asks the title bar webview to open them.
 */
function Drawer() {
  const [state, setState] = useState<RailState>(emptyRailState);

  useEffect(() => {
    void listServers().then(setState);
    return onRailState(setState);
  }, []);

  useEffect(() => applyTheme(state.theme), [state.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") void setChromeMode("closed"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function showMenu(s: RailServer) {
    const menu = await Menu.new({
      items: [{ id: "remove", text: `Remove ${s.name}`, action: () => void requestChrome({ remove: s.id }) }],
    });
    await menu.popup();
  }

  function pick(s: RailServer) {
    // The shell slides the drawer out when a server is picked.
    setState((st) => ({ ...st, selected: s.id }));
    void selectServer(s.id);
  }

  function reorder(active: string, over: string) {
    const ids = moveId(state.servers.map((s) => s.id), active, over);
    const byId = new Map(state.servers.map((s) => [s.id, s]));
    setState({ ...state, servers: ids.map((id) => byId.get(id)!) });
    void reorderServers(ids);
  }

  return (
    <div className="flex h-full">
      <ServerDrawer
        header={state.barHidden ? (
          <div className="-mx-2 -mt-2 mb-1 flex h-14 flex-none items-center gap-2 border-b border-border px-3">
            <h2 className="min-w-0 flex-1 text-sm font-semibold">Servers</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Close servers" onClick={() => void setChromeMode("closed")}><X /></Button>
          </div>
        ) : undefined}
        servers={state.servers} selected={state.selected} onPick={pick}
        onMenu={(s) => void showMenu(s)} onReorder={reorder} onAdd={() => void requestChrome("add")} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Drawer />);
