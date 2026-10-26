import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { inboxStore } from "../InboxButton";
import { ReminderList } from "../reminders/ReminderList";
import { MentionsPage } from "./MentionsPage";
import { ScreenHeader } from "./ScreenHeader";
import { YouPage } from "./YouPage";

/** Desktop has no mentions page: open the inbox popover over Home instead. */
function InboxRedirect() {
  useEffect(() => inboxStore.setState({ open: true }), []);
  return <Navigate to="/" replace />;
}

export function MentionsRoute() {
  return useIsMobile() ? <MentionsPage /> : <InboxRedirect />;
}

export function YouRoute() {
  const { section } = useParams();
  return useIsMobile() ? <YouPage /> : <Navigate to={`/settings/${section ?? ""}`} replace />;
}

/** Phones: my reminders as a pushed screen off the You tab. Desktop keeps them in the sidebar's Me tab. */
export function RemindersRoute() {
  return useIsMobile() ? (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Reminders">
      <ScreenHeader title="Reminders" />
      <ReminderList className="pb-safe" />
    </main>
  ) : <Navigate to="/notes" replace />;
}
