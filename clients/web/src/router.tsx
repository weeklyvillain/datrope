import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { DMView } from "./app/DMView";
import { AlbumRoute, AlbumsRoute, ChannelRoute, GlobalGalleryRoute, Home } from "./app/Home";
import { MentionsRoute, YouRoute } from "./app/mobile/PhoneRoutes";
import { RequireSession } from "./app/RequireSession";
import { ServerSettings } from "./app/server-settings/ServerSettings";
import { UserSettingsRoute } from "./app/settings/UserSettingsPage";
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
        { path: "gallery/albums", element: <AlbumsRoute /> },
        { path: "gallery/albums/:albumId", element: <AlbumRoute /> },
        { path: "messages/:channelId?", element: <DMView /> },
        { path: "mentions", element: <MentionsRoute /> },
        { path: "you/:section?", element: <YouRoute /> },
        { path: "settings/:section?", element: <UserSettingsRoute /> },
        { path: "server-settings/:section?", element: <ServerSettings /> },
        { path: "admin", element: <Navigate to="/server-settings/sign-ups" replace /> },
      ],
    }],
  },
]);
