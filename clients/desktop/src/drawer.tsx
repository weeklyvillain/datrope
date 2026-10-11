import { Menu } from "@tauri-apps/api/menu";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { moveId } from "./order";
import {
  emptyRailState, listServers, onRailState, reorderServers, requestChrome, selectServer, setChromeMode,
  type RailServer, type RailState,
} from "./rail-api";
import { ServerDrawer } from "./ServerDrawer";
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
      <ServerDrawer servers={state.servers} selected={state.selected} onPick={pick}
        onMenu={(s) => void showMenu(s)} onReorder={reorder} onAdd={() => void requestChrome("add")} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Drawer />);
