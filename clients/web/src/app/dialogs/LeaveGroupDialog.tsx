import { useNavigate } from "react-router-dom";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorText } from "@/components/error-text";
import { useSubmit } from "@/hooks/use-submit";
import { client, dmName, useApp } from "../../session";

/** Confirms leaving a group DM; leaving the open one goes back to the conversation list. */
export function LeaveGroupDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const name = useApp((s) => dmName(s.channels[channelId], s.me?.id));
  const nav = useNavigate();
  const { busy, error, run } = useSubmit();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave the group with {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You will no longer see this conversation. To come back, someone has to start a new group with you.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorText error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy}
            onClick={(e) => {
              e.preventDefault(); // stay open to show an error
              void run(async () => {
                await client.leaveDM(channelId);
                onClose();
                if (location.pathname === `/messages/${channelId}`) nav("/messages");
              });
            }}>
            Leave group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
