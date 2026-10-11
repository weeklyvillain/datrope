# Self-assignable roles and role mentions

Date: 2026-10-11

## Goal

Members pick their own roles on the welcome page. A role unlocks channels
(through the existing per-role channel overrides) and can be pinged with
`@role`. Only allowed people can ping a role; everyone who holds it receives
the ping.

## Decisions

- Both features ship together (one spec).
- Role pings: a per-role `mentionable` flag plus a new `MentionRoles`
  permission (Discord model). Holders of `MentionRoles` can ping any role.
- The picker is an optional section in the welcome channel. It is not part of
  the rules gate. Changes save immediately.
- Picker layout: a flat list in role order, with an optional one-line
  description per role. No sections.
- Role mentions use a token, `<@&roleID>`, inserted by autocomplete and
  rendered as a colored pill.

## 1. Data model and safety

Migration `server/internal/db/migrations/00034_self_roles.sql`:

- `roles.self_assignable BOOL NOT NULL DEFAULT false`
- `roles.mentionable BOOL NOT NULL DEFAULT false`
- `roles.description TEXT NOT NULL DEFAULT ''` with
  `CHECK (char_length(description) <= 120)`
- `messages.mention_roles BIGINT[] NOT NULL DEFAULT '{}'`, with a GIN index if
  the inbox query plan needs one.

New permission `perms.MentionRoles = 1 << 23`:

- Defined in `server/internal/perms/perms.go`.
- Mirrored in `clients/core/src/perms.ts` and labeled in
  `clients/web/src/permLabels.ts`.
- Not part of `Default`, `GuestDefault` or `DM`.
- Part of `All`.

Safety rules, enforced on the server:

- @everyone and guest roles (`is_guest`) can never be `self_assignable`.
- Power bits:
  - The set is `Admin`, `ManageMessages`, `ManageRoles`, `ManageChannels`,
    `ManageServer`, `ManageExpressions`, `ManageWebhooks`, `Kick`, `Ban`,
    `MuteMembers`, `MoveMembers`, `MentionEveryone` and `MentionRoles`.
  - A self-assignable role may not carry any of them.
  - Both directions are rejected with 400: setting `self_assignable=true` on a
    role that has power bits, and adding power bits to a role that is
    self-assignable.
  - The set lives in one place: `perms.SelfAssignSafe(p int64) bool`.
- Channel overrides on self-assignable roles are not restricted. Granting
  channel access is the point of the feature, and the overrides are the
  admin's responsibility.

Editing the flags:

- The new fields are set through the existing `PATCH /api/server/roles/{roleID}`
  with the existing `ManageRoles` and hierarchy checks.
- `RoleUpdate` gains `self_assignable`, `mentionable` and `description`.
- `Role` and the `ROLE_CREATE` / `ROLE_UPDATE` payloads carry them.
- `POST /api/server/roles` accepts them too, under the same validation.

## 2. Self-assign API and UI

New file `server/internal/communities/self_roles.go`, registered from
`Register`.

Routes:

- `PUT /api/server/me/roles/{roleID}` adds the role. Returns 204.
- `DELETE /api/server/me/roles/{roleID}` removes it. Returns 204.

Who may call:

- Any member, through `requireActor` with no permission bit, so the rules gate
  (`errGated`) applies.
- Guests get 403.

Validation:

- Unknown role: 404.
- Role is not `self_assignable`: 403. This also covers @everyone and guest
  roles.
- No rank or hierarchy check. The safety rules in section 1 replace it.

Behavior:

- Idempotent. Adding a held role or removing an unheld one is a no-op that
  returns 204 and publishes nothing.
- On a change, publishes `MEMBER_UPDATE` with the same payload and scope as the
  admin assign path (`roles.go` `assign`).
- Clients already recompute permissions and channel visibility from that event.

Client core: add `addMyRole(roleID)` / `removeMyRole(roleID)` API helpers.
Regenerate the schema with `pnpm gen` in `clients/core`.

Welcome UI, new `clients/web/src/app/welcome/SelfRolePicker.tsx`:

- Rendered in `WelcomeView.tsx` below the welcome markdown, under the heading
  "Pick your roles".
- Renders only if at least one self-assignable role exists.
- One toggle card per role, in role position order:
  - Built from shadcn primitives (`Switch` inside a card layout, or `Toggle`).
  - Shows the role icon (`role-icon`), the name in the role color and the
    description line.
  - The accessible name of the switch is the role name.
- Toggling calls the API at once, with an optimistic update. On error it rolls
  back and shows a toast.
- If the member has not yet accepted the rules (gate on), the switches are
  disabled with the hint "Accept the rules to pick roles".
- Guests do not see the section.
- Tokens only, dark-only, `cn()` for classes.

Admin UI, `clients/web/src/app/server-settings/RoleEditor.tsx`:

- New controls:
  - "Self-assignable" switch.
  - "Mentionable by anyone" switch.
  - "Description" input, max 120 chars, with a hint that it is shown on the
    welcome page.
- The self-assignable switch is disabled, with an explanation, while the role
  has power bits. The same applies to @everyone and guest roles.
- When the role is self-assignable, the permission toggles for power bits are
  disabled, with the same explanation.

## 3. Role mentions

Parsing (`server/internal/messages/mentions.go`):

- `roleMentionRe = <@&(\d+)>`, applied after stripping code blocks and inline
  code, the same way user mentions are.
- Results are de-duplicated and in order.
- User mentions and role mentions share the `maxMentions` cap of 20.
- `@everyone` handling is unchanged.

Resolving:

- A role token pings only if all of these hold:
  - the role exists in the community;
  - it is not @everyone;
  - it is `mentionable`, or the author has `MentionRoles` in the channel
    (effective permissions, so channel overrides apply).
- Webhook messages can only ping `mentionable` roles.
- Tokens that don't qualify stay in the text and render as a pill, but they are
  not stored in `mention_roles` and ping nobody.
- Resolved IDs go into `messages.mention_roles`, on create and on edit, in the
  same places `mentions` is computed today.
- Message payloads (REST and gateway) include `mention_roles`.

Inbox (`server/internal/messages/inbox.go`):

- `mentionsWhere` gains
  `OR m.mention_roles && ARRAY(SELECT role_id FROM member_roles WHERE user_id = $1)`.
- This counts current holders. A member who joins a role later also sees its
  older pings. That is accepted; there is no snapshot of holders at send time.
- The existing readable-channel filter still applies.
- The list, the unread count and `AckMentions` all use the same clause.

Client:

- Store and highlight:
  - A message mentions me if `mentions` contains me, or `mention_everyone`, or
    `mention_roles` intersects my role IDs.
  - This drives the mention highlight (`clients/web/src/chat/highlight.ts`) and
    unread mention badges.
- Autocomplete (`clients/web/src/chat/autocomplete.ts` and its UI):
  - The `@` list shows users first, then roles.
  - Roles listed: mentionable ones, or all non-@everyone roles if I have
    `MentionRoles` in the current channel.
  - Picking a role inserts `<@&id>`.
- Rendering (`clients/web/src/chat/remarkChat.ts`):
  - `<@&id>` outside code becomes a pill `@Role Name` in the role color.
  - A deleted role renders as `@deleted-role`.

## Error handling

- Self-assign errors use the standard `httpx` errors: 403 not self-assignable or
  guest, 404 unknown role, plus the gate error.
- Role PATCH or create that violates the safety rules returns 400, with a
  message naming the conflict.
- Mention resolution never fails a send. Unresolvable tokens are ignored.

## Testing

Go:

- `communities/self_roles_test.go`:
  - add and remove work, are idempotent and publish `MEMBER_UPDATE`;
  - non-self-assignable role returns 403;
  - guest returns 403;
  - gated member is blocked;
  - an unknown role returns 404.
- `communities/roles_test.go`:
  - the power-bit rules in both directions;
  - @everyone and guest roles can't be self-assignable;
  - the description length check.
- `messages` tests:
  - token parsing, including inside code;
  - mentionable vs non-mentionable vs `MentionRoles` (including a channel
    override);
  - webhook messages;
  - re-resolve on edit;
  - inbox list and count via role membership;
  - no ping in an unreadable channel.
- `perms` test for `SelfAssignSafe`.

Vitest:

- Token rendering: pill, deleted role, ignored inside code.
- Autocomplete role filtering and insertion.
- The highlight / mentions-me helper.
- `SelfRolePicker`: renders roles, toggles, disabled when gated, hidden when no
  roles.
- `RoleEditor` toggles.

Playwright (`clients/web/e2e/chat.spec.ts`), one flow:

1. Admin creates a role, sets a description and marks it self-assignable and
   mentionable.
2. Admin hides a channel from @everyone and allows it for the role.
3. A member picks the role on the welcome page and the channel appears.
4. A second user sends a message pinging the role.
5. The member sees the mention.

## Out of scope

- A role-picking step in the rules / onboarding flow.
- Picker sections or categories.
- Per-member opt-out of role pings.
- Rate limits on role pings.
