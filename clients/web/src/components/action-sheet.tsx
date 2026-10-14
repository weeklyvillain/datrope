import * as React from "react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { useHistoryLayer } from "@/hooks/use-history-layer";
import { cn } from "@/lib/utils";

export function ActionSheet({ open, onOpenChange, title, header, role = "menu", children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; header?: React.ReactNode; role?: "menu" | "group"; children: React.ReactNode;
}) {
  useHistoryLayer(`sheet:${title}`, open, () => onOpenChange(false));
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-safe px-safe">
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        {header}
        <div role={role} aria-label={title} className="flex flex-col px-2 pb-2">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

export function ActionSheetItem({ icon, children, onSelect, destructive, disabled }: {
  icon?: React.ReactNode; children: React.ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}
      className={cn("flex min-h-[48px] items-center gap-3 rounded-md px-3 text-left text-[15px] hover:bg-accent focus-visible:bg-accent disabled:opacity-50 [&_svg]:size-5",
        destructive ? "text-destructive" : "text-foreground")}>
      {icon}{children}
    </button>
  );
}
