import { Link2, Music } from "lucide-react";
import type { ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BrandIcon, hasBrandIcon } from "@/lib/brand-icons";
import { siteNames } from "@/lib/music";
import { cn } from "@/lib/utils";
import { sizedImage } from "@/lib/sized-image";

/** A track's or playlist's cover image, or a note when it has none. */
export function Cover({ src, className }: { src?: string; className?: string }) {
  return (
    <span className={cn("grid size-10 flex-none place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground", className)}>
      {src ? <img {...sizedImage(src, 48)} alt="" className="size-full object-cover" loading="lazy" /> : <Music className="size-1/2" aria-hidden />}
    </span>
  );
}

/** The site a link track comes from; nothing for uploads. */
export function SiteIcon({ site, className }: { site?: string; className?: string }) {
  if (!site) return null;
  const name = siteNames[site] ?? site;
  return hasBrandIcon(site)
    ? <BrandIcon slug={site} role="img" aria-hidden={false} aria-label={name} className={cn("size-3.5 flex-none", className)} />
    : <Link2 role="img" aria-label={name} className={cn("size-3.5 flex-none", className)} />;
}

/** "Are you sure?" before something that can't be undone. */
export function ConfirmAction({ open, onOpenChange, title, description, action, destructive, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  action: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
