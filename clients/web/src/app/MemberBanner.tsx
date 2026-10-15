import { sizedImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";

/**
 * A member's profile banner as a dimmed wash behind their row (mockup MemberBanner.html, concept A): it fades in from
 * the left so the avatar and name stay readable. The row button must be `relative isolate overflow-hidden group`.
 */
export function MemberBanner({ url, dim = false }: { url?: string; dim?: boolean }) {
  if (!url) return null;
  const img = sizedImage(url, 240);
  return (
    <img {...img} alt="" aria-hidden loading="lazy" decoding="async" draggable={false}
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 size-full object-cover transition-opacity duration-150",
        "[mask-image:linear-gradient(to_right,transparent_15%,black_85%)]",
        dim ? "opacity-15 group-hover:opacity-25" : "opacity-30 group-hover:opacity-40",
      )} />
  );
}
