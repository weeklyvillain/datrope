import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { inboxStore } from "../InboxButton";
import { MentionsPage } from "./MentionsPage";
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
