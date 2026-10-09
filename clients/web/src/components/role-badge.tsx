import type { Role } from "@datrope/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant="outline">
      <span aria-hidden className={cn("size-2 rounded-full", !role.color && "bg-muted-foreground")}
        style={role.color ? { background: role.color } : undefined} />
      {role.name}
    </Badge>
  );
}
