import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorText } from "@/components/error-text";
import { RefButton } from "@/components/ref-button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { errorText } from "../../session";
import { deleteNote } from "./notes-store";

/** ⋯ for the open note: Delete, after a confirm. */
export function NoteMenu({ noteId, onDeleted }: { noteId: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const remove = () => {
    setError("");
    deleteNote(noteId).then(onDeleted, (e: unknown) => setError(errorText(e)));
  };
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <RefButton variant="ghost" size="icon-sm" aria-label="Note options" className="text-muted-foreground"><MoreHorizontal /></RefButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}><Trash2 />Delete note</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>It's removed from all your devices. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorText error={error} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(e) => { e.preventDefault(); remove(); }}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
