import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Loading placeholder rows for list content; announced as a status. */
export function ListSkeleton({ rows = 5, rowClassName = "h-8", className }: { rows?: number; rowClassName?: string; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("grid gap-2 p-4", className)}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={cn("w-full", rowClassName)} />)}
    </div>
  );
}

/** Loading placeholder tiles for grid content; pass the same grid classes as the real grid. */
export function GridSkeleton({ tiles = 8, className }: { tiles?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={className}>
      {Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="aspect-square" />)}
    </div>
  );
}
