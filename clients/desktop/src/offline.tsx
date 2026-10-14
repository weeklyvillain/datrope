import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { retryDelay } from "./retry";
import { applyTheme, parseThemeFragment } from "./theme";
import "./rail.css";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
applyTheme(parseThemeFragment(location.hash, (v) => CSS.supports("color", v)));
const host = params.get("host") ?? "the server";

function Offline() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A new object per schedule, so the same delay twice (60 s, 60 s) still restarts the timer.
  const [next, setNext] = useState({ delay: retryDelay(0) });
  const attempts = useRef(0);
  const trying = useRef(false);

  const retry = useCallback(async () => {
    if (trying.current) return;
    trying.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await invoke("server_retry", { id });
    } catch (e) {
      setError(typeof e === "string" ? e : "Still can't reach it.");
    } finally {
      attempts.current += 1;
      setNext({ delay: retryDelay(attempts.current) });
      trying.current = false;
      setBusy(false);
    }
  }, []);

  // Retries on its own (at autostart the network may not be up yet), and right away when the network comes back.
  useEffect(() => {
    const t = setTimeout(() => void retry(), next.delay * 1000);
    return () => clearTimeout(t);
  }, [next, retry]);
  useEffect(() => {
    const online = () => void retry();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [retry]);

  return (
    <main className="flex h-full items-center justify-center bg-background p-6">
      <div className="grid max-w-sm gap-3 text-center">
        <h1 className="m-0 text-xl font-semibold text-foreground">Can't reach {host}</h1>
        <p className="m-0 text-sm text-muted-foreground">Check your connection, or whether the server is running.</p>
        {error && <p role="alert" className="m-0 text-sm text-destructive">{error}</p>}
        <Button onClick={() => void retry()} disabled={busy}>{busy ? "Trying…" : "Retry"}</Button>
        <p role="status" className="m-0 text-sm text-muted-foreground">{busy ? "" : `Retrying in ${next.delay} s…`}</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Offline />);
