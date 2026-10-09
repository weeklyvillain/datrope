import type { Category } from "@datrope/core";
import { ChevronDown, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import type { HTMLAttributes, Ref } from "react";
import { RefButton } from "@/components/ref-button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type CategoryAction = "create" | "rename" | "delete";

/** A category's label: toggles collapse, is the drag handle for managers, and has the category menu. */
export function CategoryHeader({ category, collapsed, onToggle, onAction, canManage, handle }: {
  category: Category;
  collapsed: boolean;
  onToggle: () => void;
  onAction: (a: CategoryAction) => void;
  canManage: boolean;
  handle?: HTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };
}) {
  return (
    <div className="group/cat flex items-center gap-1 pt-4 pr-1 pb-1">
      <button type="button" {...handle} aria-expanded={!collapsed} onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronDown className={cn("size-3.5 flex-none transition-transform", collapsed && "-rotate-90")} aria-hidden />
        <span className="truncate">{category.name}</span>
      </button>
      {canManage && (
        // Not modal: its items open dialogs, which a modal menu would fight for focus.
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <RefButton variant="ghost" size="icon-xs" aria-label="Category options"
              className="text-muted-foreground opacity-0 group-hover/cat:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
              <Ellipsis />
            </RefButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={() => onAction("create")}><Plus />Create channel</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("rename")}><Pencil />Rename category</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete")}><Trash2 />Delete category</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
