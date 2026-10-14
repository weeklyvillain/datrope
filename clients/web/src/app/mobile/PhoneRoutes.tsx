import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { inboxStore } from "../InboxButton";
import { openSettings } from "../settings/settings-store";
import type { SettingsSection } from "../settings/settings-store";
import { MentionsPage } from "./MentionsPage";
import { YouPage } from "./YouPage";

/** Desktop has no page for these: open the popover or dialog over Home instead. */
function DesktopRedirect({ kind, section }: { kind: "mentions" | "settings"; section?: string }) {
  useEffect(() => {
    if (kind === "mentions") inboxStore.setState({ open: true });
    else openSettings((section as SettingsSection | undefined) ?? "profile");
  }, [kind, section]);
  return <Navigate to="/" replace />;
}

export function MentionsRoute() {
  return useIsMobile() ? <MentionsPage /> : <DesktopRedirect kind="mentions" />;
}

export function YouRoute() {
  const { section } = useParams();
  return useIsMobile() ? <YouPage /> : <DesktopRedirect kind="settings" section={section} />;
}
