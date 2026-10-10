import { useEffect, useState } from "react";

/** Phones: below Tailwind's md breakpoint, where the sidebar becomes a drawer. */
export const MOBILE_QUERY = "(max-width: 767px)";

const matches = () => typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_QUERY).matches;

/** True on a phone-sized screen; follows rotation and resizing. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(matches);
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY);
    if (!mq) return;
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}
