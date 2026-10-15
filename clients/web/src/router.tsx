import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { DMView } from "./app/DMView";
import { ChannelRoute, GalleryAlbumRoute, Home } from "./app/Home";
import { MentionsRoute, YouRoute } from "./app/mobile/PhoneRoutes";
import { RequireSession } from "./app/RequireSession";
import { ServerSettings } from "./app/server-settings/ServerSettings";
import { UserSettingsRoute } from "./app/settings/UserSettingsPage";
import { NotFound, RouteError } from "./pages/errors";
import { GuestEnded } from "./pages/GuestEnded";
import { InvitePage } from "./pages/Invite";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";

export const router = createBrowserRouter([{
  // Anything a page throws outside the app shell lands on a full-window error page.
  errorElement: <RouteError />,
  children: [
    { path: "/login", element: <Login /> },
    { path: "/register", element: <Register /> },
    { path: "/invite/:code", element: <InvitePage /> },
    { path: "/guest-ended", element: <GuestEnded /> },
    {
      path: "/",
      element: <RequireSession />,
      children: [{
        element: <AppShell />,
        children: [{
          // Inside the shell the error fills the content column, so the sidebar still works.
          errorElement: <RouteError inShell />,
          children: [
            { index: true, element: <Home /> },
            { path: "channels/:channelId", element: <ChannelRoute /> },
            { path: "channels/:channelId/albums/:albumId", element: <GalleryAlbumRoute /> },
            { path: "gallery/*", element: <Navigate to="/" replace /> },
            { path: "messages/:channelId?", element: <DMView /> },
            { path: "mentions", element: <MentionsRoute /> },
            { path: "you/:section?", element: <YouRoute /> },
            { path: "settings/:section?", element: <UserSettingsRoute /> },
            { path: "server-settings/:section?", element: <ServerSettings /> },
            { path: "admin", element: <Navigate to="/server-settings/sign-ups" replace /> },
            { path: "*", element: <NotFound inShell /> },
          ],
        }],
      }],
    },
  ],
}]);
