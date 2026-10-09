import { cn } from "@/lib/utils";

const colors: Record<string, string> = { online: "bg-online", idle: "bg-idle" };

export function PresenceDot({ status = "offline", className }: { status?: string; className?: string }) {
  return <span className={cn("size-[9px] flex-none rounded-full", colors[status] ?? "bg-offline", className)} role="img" aria-label={status} />;
}
