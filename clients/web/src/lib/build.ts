/** The commit this web bundle was built from; "dev" for local builds. */
export const clientBuild: string = import.meta.env.VITE_DATROPE_BUILD || "dev";

/** True when the server runs a different build than this page (never for dev builds). */
export function isStale(client: string, server: string | null): boolean {
  return !!server && client !== "dev" && server !== "dev" && client !== server;
}

const TAKEOVER_MS = 10_000; // a worker that never takes over must not leave Reload stuck

/** Resolves once worker leaves the installing state (installed, or redundant if it failed). */
function installed(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state !== "installing") return resolve();
    worker.addEventListener("statechange", function check() {
      if (worker.state !== "installing") {
        worker.removeEventListener?.("statechange", check);
        resolve();
      }
    });
  });
}

/**
 * Reloads into the new build. An installed PWA keeps serving the old app shell from its waiting
 * service worker until every window closes, so the new worker (once installed) is asked to take
 * over first. update() resolves when the new worker starts installing, not when it is done.
 */
export async function reloadToNewBuild(
  sw: ServiceWorkerContainer | undefined = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined,
  reload: () => void = () => location.reload(),
): Promise<void> {
  const reg = await sw?.getRegistration().catch(() => undefined);
  if (!sw || !reg) return reload();
  await reg.update().catch(() => undefined);
  if (reg.installing) await installed(reg.installing);
  const waiting = reg.waiting;
  if (!waiting) return reload();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TAKEOVER_MS);
    sw.addEventListener("controllerchange", () => { clearTimeout(timer); resolve(); }, { once: true });
    waiting.postMessage({ type: "SKIP_WAITING" });
  });
  reload();
}
