import type { Category } from "@datrope/core";
import { ArrowDown, ArrowUp, ChevronDown, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react";
import type { HTMLAttributes, Ref } from "react";
import { RefButton } from "@/components/ref-button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export type CategoryAction = "create" | "rename" | "delete" | "up" | "down";

/** A category's label: toggles collapse, is the drag handle for managers, and has the category menu. */
export function CategoryHeader({ category, collapsed, onToggle, onAction, canManage, canMoveUp, canMoveDown, handle }: {
  category: Category;
  collapsed: boolean;
  onToggle: () => void;
  onAction: (a: CategoryAction) => void;
  canManage: boolean;
  /** False for the first (up) or last (down) category: the item shows disabled. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  handle?: HTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
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
                  className="text-muted-foreground opacity-0 pointer-coarse:opacity-100 group-hover/cat:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
                  <Ellipsis />
                </RefButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48" onContextMenu={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => onAction("create")}><Plus />Create channel</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction("rename")}><Pencil />Rename category</DropdownMenuItem>
                <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onAction("up")}><ArrowUp />Move up</DropdownMenuItem>
                <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onAction("down")}><ArrowDown />Move down</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete")}><Trash2 />Delete category</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={onToggle}><ChevronDown />{collapsed ? "Expand category" : "Collapse category"}</ContextMenuItem>
        {canManage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onAction("create")}><Plus />Create channel</ContextMenuItem>
            <ContextMenuItem onSelect={() => onAction("rename")}><Pencil />Rename category</ContextMenuItem>
            <ContextMenuItem disabled={!canMoveUp} onSelect={() => onAction("up")}><ArrowUp />Move up</ContextMenuItem>
            <ContextMenuItem disabled={!canMoveDown} onSelect={() => onAction("down")}><ArrowDown />Move down</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onAction("delete")}><Trash2 />Delete category</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
