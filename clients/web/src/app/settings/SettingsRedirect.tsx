import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { openSettings } from "./settings-store";

/** /settings (old links): opens the settings modal over the app. */
export function SettingsRedirect() {
  useEffect(() => openSettings(), []);
  return <Navigate to="/" replace />;
}
