import { useCallback, useState, type RefCallback } from "react";

/** The content width of an element, kept current with a ResizeObserver; 0 until it is attached. */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const [observer] = useState(() => (typeof ResizeObserver === "undefined" ? undefined
    : new ResizeObserver((es) => setWidth(Math.floor(es[0]?.contentRect.width ?? 0)))));
  const ref = useCallback((el: T | null) => {
    observer?.disconnect();
    if (el) {
      setWidth(Math.floor(el.clientWidth));
      observer?.observe(el);
    }
  }, [observer]);
  return [ref, width];
}
