const loading = new Map<string, Promise<void>>();

/** Adds a script tag for `src` once; resolves when it has loaded. A failed load can be retried. */
export function loadScript(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        loading.delete(src);
        el.remove();
        reject(new Error(`could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    loading.set(src, p);
  }
  return p;
}
