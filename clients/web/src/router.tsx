import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { DMView } from "./app/DMView";
import { ChannelRoute, GlobalGalleryRoute, Home } from "./app/Home";
import { RequireSession } from "./app/RequireSession";
import { ServerSettings } from "./app/server-settings/ServerSettings";
import { SettingsRedirect } from "./app/settings/SettingsRedirect";
import { GuestEnded } from "./pages/GuestEnded";
import { InvitePage } from "./pages/Invite";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";

export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/register", element: <Register /> },
  { path: "/invite/:code", element: <InvitePage /> },
  { path: "/guest-ended", element: <GuestEnded /> },
  {
    path: "/",
    element: <RequireSession />,
    children: [{
      element: <AppShell />,
      children: [
        { index: true, element: <Home /> },
        { path: "channels/:channelId", element: <ChannelRoute /> },
        { path: "gallery", element: <GlobalGalleryRoute /> },
        { path: "messages/:channelId?", element: <DMView /> },
        { path: "settings", element: <SettingsRedirect /> },
        { path: "server-settings/:section?", element: <ServerSettings /> },
        { path: "admin", element: <Navigate to="/server-settings/sign-ups" replace /> },
      ],
    }],
  },
]);
