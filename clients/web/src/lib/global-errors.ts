import { toast } from "sonner";

/** The same error again within this long shows no second toast. */
const REPEAT_MS = 5000;

/** What a thrown value or rejection says, in one short line. */
export function errorMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return text.trim().slice(0, 200);
}

/** Browser noise that is not a failure anyone can act on: cancelled requests and ResizeObserver's loop warning. */
const ignored = (reason: unknown) =>
  (reason instanceof Error && reason.name === "AbortError") || /ResizeObserver loop/.test(errorMessage(reason));

/** Turns uncaught errors into calls to `show`, skipping noise and repeats. */
export function errorReporter(show: (message: string) => void, now = Date.now) {
  const seen = new Map<string, number>();
  return (reason: unknown) => {
    if (ignored(reason)) return;
    const message = errorMessage(reason);
    const t = now();
    if (t - (seen.get(message) ?? -Infinity) < REPEAT_MS) return;
    seen.set(message, t);
    show(message);
  };
}

/** Errors nothing caught (a throw in an event handler, a rejected promise nobody awaited) become a toast;
 *  render errors are the routes' error pages' job. The browser still logs them to the console. */
export function installGlobalErrorHandlers() {
  const report = errorReporter((message) => toast.error("Something went wrong", { description: message || undefined }));
  window.addEventListener("error", (e) => report(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));
}
