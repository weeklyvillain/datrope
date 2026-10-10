import { useEffect, useState } from "react";

/** Whether the browser window has focus, updated as it gains and loses it. */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return focused;
}
