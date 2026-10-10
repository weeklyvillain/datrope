# Sign-in, registration and invite pages — design

Date: 2026-10-10. Mockups: the Auth row of the Datrope Screens canvas (AuthSignIn, AuthRegister, AuthInvite).

## Goal

The auth pages were one small card with a 48px icon. They now let the server introduce itself before
anyone signs in: its banner or mark, icon, name, description, palette and who is around.

## Server

`GET /api/server/preview` (public, no session) returns `ServerPreview`: `name`, `description`, `palette`,
`icon_url`, `banner_url`, `created_at`, `member_count`, `online_count` (members online or idle, from the
gateway via `communities.Presence`). 404 `NOT_FOUND` until the first account creates the server.
The icon and banner were already public; the invite preview already exposed the name and member count.
No member names or avatars are exposed.

## Web

- `useServerPreview()` fetches the preview and applies its palette (`useApplyPalette`, the same rule as
  the app: a picked theme wins).
- `AuthLayout`: split screen. Left `AuthAside` (`bg-sidebar`): the banner under a scrim, else the
  Datrope mark at 10% in the accent; `ServerShowcase` shows icon, name, description and counts.
  Right: title, lede, form, "Runs on Datrope". Below 1000px the panels stack; the aside shrinks on phones.
- Sign in: "Welcome back", show/hide password (`PasswordField`), spinner while signing in.
- Create account: "You're joining" when opened from an invite link, with an "Invite … applied" note
  instead of the code field; the code field appears only for invite-only servers without a link.
  A four-step strength meter (`lib/password-strength`). First run shows the three setup steps on the left.
- Invite: a centred card over a faint mark — banner strip, overlapping icon, "You're invited to join
  <name>" (one heading), description, online / members / since. States: signed out (create account and
  join, or sign in), signed in (join, "Signed in as …", "Not you?" signs out and reloads), already a
  member (open the server), invalid or expired.

Accessible names the e2e test relies on are kept: "Create the admin account", the "Username" and
"Password" labels, the "Create account" button, the invite heading containing "Join <name>" and the
"Create account" link.
