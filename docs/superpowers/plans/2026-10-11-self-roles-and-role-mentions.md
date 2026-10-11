# Self-assignable Roles and Role Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members pick self-assignable roles on the welcome page (unlocking channels through the existing role overrides), and roles can be pinged with `<@&id>` by allowed people.

**Architecture:**

- **Server:** three new role columns (`self_assignable`, `mentionable`, `description`) and one new message column (`mention_roles`).
  - A new permission bit `MentionRoles`.
  - A safety rule: self-assignable roles never carry power bits.
  - Two self-assign endpoints, under `/api/server/me/roles/{roleID}`.
  - Role mention resolution next to the existing user mention code.
  - One extra clause in the inbox query.
- **Client:**
  - A `mentionsMe` helper in core, used wherever "mentions me" is computed today.
  - A role pill in the remark plugin.
  - Roles in `@` autocomplete.
  - New role editor controls.
  - A `SelfRolePicker` on the welcome page.

**Tech Stack:** Go 1.25 with huma v2, pgx and goose. React 18, zustand store in `@datrope/core`, shadcn/ui, Tailwind v4, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-self-roles-and-role-mentions-design.md`

## Global Constraints

- **Never commit.** AGENTS.md says the user makes all commits. Every "Commit" step below means: stage the listed files with `git add`, then stop. Run git as `git -c safe.directory='*' ...`, because the D: drive is exFAT.
- **Writing files:** the Write/Edit tools on project files may be blocked on this machine. Write files with Bash heredocs or Python, or write to the scratchpad and `cp`.
- **Go tests:** run them from PowerShell, not Git Bash, so testcontainers works: `cd server; $env:GOTOOLCHAIN='local'; go test ./internal/<pkg>/ -run <Name>`. Docker must be running.
- **Web tests:** `pnpm -C clients/web test -- <file>`. **Core tests:** `pnpm -C clients/core test -- <file>`.
- **Permission bit:** `MentionRoles = 1 << 23`. The bit values in Go and TS must be identical.
- **Power bits** (forbidden on self-assignable roles): `Admin, ManageMessages, ManageRoles, ManageChannels, ManageServer, ManageExpressions, ManageWebhooks, Kick, Ban, MuteMembers, MoveMembers, MentionEveryone, MentionRoles`.
- **Role description:** at most 120 characters.
- **Mention cap:** user mentions and role mentions share `maxMentions = 20`.
- **Role mention token:** exactly `<@&ID>`, where ID is the decimal role ID.
- **UI rules:**
  - shadcn primitives only, token colors only, dark-only (no `dark:`), `cn()` for classes, `@/` imports.
  - Keep existing accessible names unchanged.
  - Role colors come from data (`role.color`) as an inline style, the same way `role-badge.tsx` does it.
- **Error feedback:** the app has no toast library, so failures show inline with `ErrorText` (from `@/components/error-text`). This deliberately deviates from "toast" in the spec.

## Review Focus

These cases need tests. Each one is added to the task that owns the code.

1. **Admin flips `self_assignable` off while members hold the role.** Members keep the role, but they can no longer add it or drop it themselves. Covered in Task 3's test.
2. **Role token inside a code block or inline code.** It neither pings nor renders as a pill. Covered in Task 4 (server parse) and Task 7 (client render).
3. **Role mention in a DM, or a token for a role ID that doesn't exist.** It pings nobody, and the send still succeeds. Covered in Task 4.
4. **Member pinged in a channel they can't read.** It must not show up in their inbox. Covered in Task 5.
5. **Guest, or a member still held at the rules gate, calls the self-assign API.** Rejected. Covered in Task 3.

---

### Task 1: `MentionRoles` permission and the self-assign safety predicate

**Files:**
- Modify: `server/internal/perms/perms.go`
- Test: `server/internal/perms/perms_test.go`
- Modify: `clients/core/src/perms.ts`
- Modify: `clients/web/src/permLabels.ts`

**Interfaces:**
- Produces:
  - Go: `perms.MentionRoles`, `perms.SelfAssignPower Perms`, `func perms.SelfAssignSafe(p Perms) bool`.
  - TS: `Perm.MentionRoles`, `SELF_ASSIGN_POWER: number`, `selfAssignSafe(p: number): boolean` (all exported from `@datrope/core`).

- [ ] **Step 1: Write the failing Go test.** Append to `server/internal/perms/perms_test.go` (it is `package perms`):

```go
func TestSelfAssignSafe(t *testing.T) {
	require.Equal(t, Perms(1<<23), MentionRoles)
	require.True(t, All.Has(MentionRoles))
	require.False(t, Default.Has(MentionRoles))
	require.True(t, SelfAssignSafe(0))
	require.True(t, SelfAssignSafe(Default))
	for _, p := range []Perms{Admin, ManageMessages, ManageRoles, ManageChannels, ManageServer, ManageExpressions,
		ManageWebhooks, Kick, Ban, MuteMembers, MoveMembers, MentionEveryone, MentionRoles} {
		require.False(t, SelfAssignSafe(ViewChannel|p), p)
	}
}
```

If `require` is not imported in that file yet, add `"github.com/stretchr/testify/require"`.

- [ ] **Step 2: Run it and check that it fails.** Run `go test ./internal/perms/ -run TestSelfAssignSafe`. Expected: compile error `undefined: MentionRoles`.

- [ ] **Step 3: Implement in `perms.go`.**
  - Add `MentionRoles` after `MentionEveryone` in the iota block.
  - Change `All`:

```go
// All is every flag.
const All Perms = MentionRoles<<1 - 1
```

  - Add below `GuestDefault`:

```go
// SelfAssignPower is what a role members give themselves may never grant.
const SelfAssignPower = Admin | ManageMessages | ManageRoles | ManageChannels | ManageServer | ManageExpressions |
	ManageWebhooks | Kick | Ban | MuteMembers | MoveMembers | MentionEveryone | MentionRoles

// SelfAssignSafe reports whether a role granting p may be self-assignable.
func SelfAssignSafe(p Perms) bool { return p&SelfAssignPower == 0 }
```

- [ ] **Step 4: Run the perms tests and check that they pass.** Run `go test ./internal/perms/`. Expected: PASS.

- [ ] **Step 5: Mirror the change in TS (`clients/core/src/perms.ts`).**
  - Add `MentionRoles: 1 << 23,` after `MentionEveryone`.
  - Change `ALL_PERMS` to `(1 << 24) - 1`.
  - Add below `DM_PERMS`:

```ts
/** What a role members give themselves may never grant (perms.SelfAssignPower). */
export const SELF_ASSIGN_POWER = Perm.Admin | Perm.ManageMessages | Perm.ManageRoles | Perm.ManageChannels | Perm.ManageServer |
  Perm.ManageExpressions | Perm.ManageWebhooks | Perm.Kick | Perm.Ban | Perm.MuteMembers | Perm.MoveMembers |
  Perm.MentionEveryone | Perm.MentionRoles;
export const selfAssignSafe = (p: number) => (p & SELF_ASSIGN_POWER) === 0;
```

- [ ] **Step 6: Add the permission label.** In `clients/web/src/permLabels.ts`:
  - After the MentionEveryone entry in `PERM_LABELS`, add:

```ts
  { flag: Perm.MentionRoles, label: "Mention any role", description: "Ping any role with @role, even roles not set as mentionable by anyone.", channel: true },
```

  - In `PERM_GROUPS` "Text", add `Perm.MentionRoles` right after `Perm.MentionEveryone`.

- [ ] **Step 7: Run the client tests.** Run `pnpm -C clients/core test` and `pnpm -C clients/web test`. Expected: PASS. Existing tests that check every flag appears exactly once must still pass. If a core test pins `ALL_PERMS`, update its expected value to `(1 << 24) - 1`.

- [ ] **Step 8: Stage.** `git add server/internal/perms clients/core/src/perms.ts clients/web/src/permLabels.ts`

---

### Task 2: Role columns, migration and create/update validation

**Files:**
- Create: `server/internal/db/migrations/00034_self_roles.sql`
- Modify: `server/internal/communities/communities.go` (the `Role` struct, `roleCols` and `scanRole`)
- Modify: `server/internal/communities/roles.go` (request structs, create-role, update-role)
- Test: `server/internal/communities/roles_test.go`

**Interfaces:**
- Consumes: `perms.SelfAssignSafe` (Task 1).
- Produces:
  - JSON fields on `Role`: `self_assignable: bool`, `mentionable: bool`, `description: string`.
  - Request fields with the same names on POST and PATCH `/api/server/roles`.
  - Error codes `SELF_ASSIGN_POWER` and `CANNOT_SELF_ASSIGN` (both 400).
  - Column `messages.mention_roles BIGINT[]`, used by Task 4.

- [ ] **Step 1: Write the failing test.** Append to `roles_test.go`:

```go
func TestSelfAssignableRoleRules(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	sv := alice.Server()
	base := "/api/server/roles"

	var raid communities.Role
	alice.Do(http.MethodPost, base, map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true,
		"mentionable": true, "description": "Raid nights, pinged on Fridays"}, http.StatusCreated, &raid)
	require.True(t, raid.SelfAssignable)
	require.True(t, raid.Mentionable)
	require.Equal(t, "Raid nights, pinged on Fridays", raid.Description)

	// Power bits and self-assignable never meet, in either order.
	alice.Fail(http.MethodPost, base, map[string]any{"name": "x", "permissions": uint64(perms.Kick), "self_assignable": true},
		http.StatusBadRequest, "SELF_ASSIGN_POWER")
	alice.Fail(http.MethodPatch, base+"/"+raid.ID.String(), map[string]any{"permissions": uint64(perms.ManageMessages)},
		http.StatusBadRequest, "SELF_ASSIGN_POWER")
	var mods communities.Role
	alice.Do(http.MethodPost, base, map[string]any{"name": "Mods", "permissions": uint64(perms.Ban)}, http.StatusCreated, &mods)
	alice.Fail(http.MethodPatch, base+"/"+mods.ID.String(), map[string]any{"self_assignable": true},
		http.StatusBadRequest, "SELF_ASSIGN_POWER")
	// Harmless permissions are fine.
	alice.Do(http.MethodPatch, base+"/"+raid.ID.String(), map[string]any{"permissions": uint64(perms.AttachFiles)}, http.StatusOK, nil)

	// @everyone and the Guest role can't be self-assignable.
	alice.Fail(http.MethodPatch, base+"/"+sv.ID.String(), map[string]any{"self_assignable": true},
		http.StatusBadRequest, "CANNOT_STYLE_EVERYONE")
	alice.GuestInvite(3600) // creates the Guest role
	for _, r := range alice.Server().Roles {
		if r.IsGuest {
			alice.Fail(http.MethodPatch, base+"/"+r.ID.String(), map[string]any{"self_assignable": true},
				http.StatusBadRequest, "CANNOT_SELF_ASSIGN")
		}
	}

	// Description length.
	alice.Fail(http.MethodPatch, base+"/"+raid.ID.String(), map[string]any{"description": strings.Repeat("a", 121)},
		http.StatusBadRequest, "VALIDATION_FAILED")
	var cleared communities.Role
	alice.Do(http.MethodPatch, base+"/"+raid.ID.String(), map[string]any{"self_assignable": false, "description": ""}, http.StatusOK, &cleared)
	require.False(t, cleared.SelfAssignable)
	require.Empty(t, cleared.Description)
	require.True(t, cleared.Mentionable, "omitted fields are unchanged")
}
```

Notes on this test:
- Add `"strings"` to the imports.
- The 400 `VALIDATION_FAILED` for over-long input matches `welcome_test.go:26`.
- `GuestInvite` is an existing apptest helper (`guests_test.go:23`).

- [ ] **Step 2: Run it and check that it fails.** Run `go test ./internal/communities/ -run TestSelfAssignableRoleRules`. Expected: compile error, `SelfAssignable` is undefined.

- [ ] **Step 3: Add the migration** `00034_self_roles.sql`:

```sql
-- +goose Up
-- Roles members give themselves on the welcome page, and roles anyone may ping.
ALTER TABLE roles
  ADD COLUMN self_assignable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN mentionable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 120);
-- The roles a message pinged (resolved at send/edit time).
ALTER TABLE messages ADD COLUMN mention_roles BIGINT[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE messages DROP COLUMN mention_roles;
ALTER TABLE roles DROP COLUMN description, DROP COLUMN mentionable, DROP COLUMN self_assignable;
```

- [ ] **Step 4: Extend `Role` in `communities.go`.**
  - Add the fields after `IconURL`:

```go
	SelfAssignable bool   `json:"self_assignable" doc:"Members can give themselves this role on the welcome page"`
	Mentionable    bool   `json:"mentionable" doc:"Anyone can ping this role; otherwise only holders of MENTION_ROLES"`
	Description    string `json:"description" doc:"Shown next to the role in the welcome page's role picker"`
```

  - Change `roleCols` to end with `..., icon_emoji, icon_sha256, self_assignable, mentionable, description`.
  - In `scanRole`, append `&r.SelfAssignable, &r.Mentionable, &r.Description` to the `Scan` call.

- [ ] **Step 5: Extend the requests in `roles.go`.**
  - `CreateRoleRequest`:

```go
	SelfAssignable bool   `json:"self_assignable,omitempty"`
	Mentionable    bool   `json:"mentionable,omitempty"`
	Description    string `json:"description,omitempty" maxLength:"120"`
```

  - `UpdateRoleRequest`:

```go
	SelfAssignable *bool   `json:"self_assignable,omitempty"`
	Mentionable    *bool   `json:"mentionable,omitempty"`
	Description    *string `json:"description,omitempty" maxLength:"120"`
```

  - Add the helper below `canTouch`:

```go
// checkSelfAssign: a role members give themselves grants no power and is never the Guest role.
func checkSelfAssign(guest, selfAssignable bool, p perms.Perms) error {
	if !selfAssignable {
		return nil
	}
	if guest {
		return httpx.BadRequest("CANNOT_SELF_ASSIGN", "the Guest role cannot be self-assignable")
	}
	if !perms.SelfAssignSafe(p) {
		return httpx.BadRequest("SELF_ASSIGN_POWER", "a self-assignable role cannot grant moderation, admin or mention permissions")
	}
	return nil
}
```

- [ ] **Step 6: Update the create-role handler.**
  - After `canTouch(a, in.Body.Permissions)`:

```go
			if err := checkSelfAssign(false, in.Body.SelfAssignable, in.Body.Permissions); err != nil {
				return nil, err
			}
```

  - Replace the INSERT with:

```go
			r, err := scanRole(tx.QueryRow(ctx, `
				INSERT INTO roles (id, community_id, name, permissions, position, color, hoist, self_assignable, mentionable, description)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				RETURNING `+roleCols,
				id.New(), a.CommunityID, strings.TrimSpace(in.Body.Name), int64(in.Body.Permissions), pos, in.Body.Color, in.Body.Hoist,
				in.Body.SelfAssignable, in.Body.Mentionable, strings.TrimSpace(in.Body.Description)))
```

- [ ] **Step 7: Update the update-role handler.**
  - Extend the @everyone case:

```go
				case b.Color != nil || b.ClearColor || b.Hoist != nil || b.IconEmoji != nil ||
					b.SelfAssignable != nil || b.Mentionable != nil || b.Description != nil:
```

  - After the `canTouch(a, check...)` block, add:

```go
			sa, final := r.SelfAssignable, r.Permissions
			if b.SelfAssignable != nil {
				sa = *b.SelfAssignable
			}
			if b.Permissions != nil {
				final = *b.Permissions
			}
			if err := checkSelfAssign(r.IsGuest, sa, final); err != nil {
				return nil, err
			}
			var desc *string
			if b.Description != nil {
				d := strings.TrimSpace(*b.Description)
				desc = &d
			}
```

  - Replace the UPDATE query:

```go
			updated, err := scanRole(tx.QueryRow(ctx, `
				UPDATE roles SET name = COALESCE($3, name), permissions = COALESCE($4, permissions),
				                 color = CASE WHEN $5::text IS NOT NULL THEN $5 WHEN $6 THEN NULL ELSE color END,
				                 hoist = COALESCE($7, hoist), self_assignable = COALESCE($8, self_assignable),
				                 mentionable = COALESCE($9, mentionable), description = COALESCE($10, description)
				WHERE id = $1 AND community_id = $2
				RETURNING `+roleCols,
				r.ID, a.CommunityID, b.Name, newPerms, b.Color, b.ClearColor, b.Hoist, b.SelfAssignable, b.Mentionable, desc))
```

- [ ] **Step 8: Run the tests and check that they pass.** Run `go test ./internal/communities/ ./internal/db/`. Expected: PASS, both the new test and the existing role, hierarchy and migration tests.

- [ ] **Step 9: Stage.** `git add server/internal/db/migrations/00034_self_roles.sql server/internal/communities`

---

### Task 3: Self-assign endpoints

**Files:**
- Create: `server/internal/communities/self_roles.go`
- Modify: `server/internal/communities/handlers.go` (call the registrar next to `registerRoles`, about line 229)
- Test: `server/internal/communities/self_roles_test.go`

**Interfaces:**
- Consumes: `Role.SelfAssignable` (Task 2), `requireActor`, `errGated`, `publishMemberUpdate`, `rolePath`, `auth.IsGuest`.
- Produces:
  - `PUT /api/server/me/roles/{roleID}` (operation id `add-my-role`) and `DELETE` (operation id `remove-my-role`). Both return 204.
  - Error code `NOT_SELF_ASSIGNABLE` (403).

- [ ] **Step 1: Write the failing test** `self_roles_test.go`:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
)

func TestSelfAssignRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	var raid, mods communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true}, http.StatusCreated, &raid)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Mods", "permissions": 0}, http.StatusCreated, &mods)
	mine := "/api/server/me/roles/"
	roleIDs := func(c *apptest.Client) []id.ID {
		for _, m := range alice.Members() {
			if m.User.ID == c.User.ID {
				return m.RoleIDs
			}
		}
		return nil
	}

	ws, _ := bob.Connect()
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	var m communities.Member
	ws.ExpectDispatch("MEMBER_UPDATE", &m)
	require.Equal(t, []id.ID{raid.ID}, m.RoleIDs)
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil) // idempotent
	ws.ExpectNoDispatch("MEMBER_UPDATE", 300*time.Millisecond)

	bob.Fail(http.MethodPut, mine+mods.ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
	bob.Fail(http.MethodPut, mine+alice.Server().ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
	bob.Fail(http.MethodPut, mine+id.New().String(), nil, http.StatusNotFound, "NOT_FOUND")

	bob.Do(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	require.Empty(t, roleIDs(bob))
	bob.Do(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusNoContent, nil) // idempotent

	// Unflagged: holders keep the role but can no longer change it themselves.
	bob.Do(http.MethodPut, mine+raid.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodPatch, "/api/server/roles/"+raid.ID.String(), map[string]any{"self_assignable": false}, http.StatusOK, nil)
	require.Equal(t, []id.ID{raid.ID}, roleIDs(bob))
	bob.Fail(http.MethodDelete, mine+raid.ID.String(), nil, http.StatusForbidden, "NOT_SELF_ASSIGNABLE")
}

func TestSelfAssignBlockedForGuestsAndGated(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var raid communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "self_assignable": true}, http.StatusCreated, &raid)
	path := "/api/server/me/roles/" + raid.ID.String()

	guest := env.JoinAsGuest(alice.GuestInvite(3600), "visitor")
	guest.Fail(http.MethodPut, path, nil, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	carol := env.Register("carol")
	carol.Fail(http.MethodPut, path, nil, http.StatusForbidden, "RULES_NOT_ACCEPTED")
	carol.Do(http.MethodPost, "/api/server/welcome/accept", nil, http.StatusNoContent, nil)
	carol.Do(http.MethodPut, path, nil, http.StatusNoContent, nil)
}
```

Notes on this test:
- Add `"time"` to the imports.
- If apptest has no `Members()` helper, use `alice.Do(http.MethodGet, "/api/server/members", nil, http.StatusOK, &members)` inside `roleIDs`, the same way `roles_test.go:30` does.
- Check the status that `/api/server/welcome/accept` returns in `welcome.go:81` and use it.

- [ ] **Step 2: Run it and check that it fails.** Run `go test ./internal/communities/ -run TestSelfAssign`. Expected: FAIL with 404 or 405, because the route doesn't exist yet.

- [ ] **Step 3: Implement `self_roles.go`.**

```go
package communities

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

// registerSelfRoles adds the welcome page's role picker: members give
// themselves, or drop, roles an admin marked self-assignable.
func registerSelfRoles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	set := func(add bool) func(context.Context, *rolePath) (*struct{}, error) {
		return func(ctx context.Context, in *rolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			if a.Member.Gated {
				return nil, errGated()
			}
			if auth.IsGuest(ctx) {
				return nil, httpx.MissingPermission()
			}
			roleID, err := httpx.ParseID(in.RoleID, "role")
			if err != nil {
				return nil, err
			}
			var selfAssignable bool
			err = s.db.QueryRow(ctx, `SELECT self_assignable FROM roles WHERE id = $1 AND community_id = $2`,
				roleID, a.CommunityID).Scan(&selfAssignable)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("role")
			}
			if err != nil {
				return nil, err
			}
			if !selfAssignable {
				return nil, httpx.E(http.StatusForbidden, "NOT_SELF_ASSIGNABLE", "only moderators can give or take this role")
			}
			sql := `DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3`
			if add {
				sql = `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
			}
			tag, err := s.db.Exec(ctx, sql, a.CommunityID, a.Member.UserID, roleID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, nil // already so
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, a.Member.UserID)
		}
	}
	huma.Register(api, op("add-my-role", http.MethodPut, "/api/server/me/roles/{roleID}", http.StatusNoContent), set(true))
	huma.Register(api, op("remove-my-role", http.MethodDelete, "/api/server/me/roles/{roleID}", http.StatusNoContent), set(false))
}
```

The @everyone role ID equals the community ID. Its `self_assignable` is always false, because Task 2 rejects setting it, so it gets `NOT_SELF_ASSIGNABLE`.

- [ ] **Step 4: Register it.** In `handlers.go`, next to `registerRoles(api, s, op)`, add `registerSelfRoles(api, s, op)`.

- [ ] **Step 5: Run the tests and check that they pass.** Run `go test ./internal/communities/`. Expected: PASS.

- [ ] **Step 6: Stage.** `git add server/internal/communities`

---

### Task 4: Role mention parsing, resolution and storage

**Files:**
- Modify: `server/internal/messages/mentions.go`
- Modify: `server/internal/messages/messages.go` (the `Message` struct, `messageCols` and `scanMessage`)
- Modify: `server/internal/messages/handlers.go` (create, about lines 153–169; edit, about lines 252–263)
- Modify: `server/internal/messages/posts.go` (about lines 54–73)
- Modify: `server/internal/messages/webhook.go` (`PostWebhook`, about lines 187–260)
- Modify: `server/internal/messages/dm_leave.go:57` and `server/internal/messages/system_post.go:13` (set `MentionRoles: []id.ID{}`)
- Test: `server/internal/messages/mentions_test.go` (unit) and `server/internal/messages/role_mentions_test.go` (integration)
- Test: `server/internal/webhooks/execute_test.go` (the webhook case)

**Interfaces:**
- Consumes: `roles.mentionable` and `messages.mention_roles` (Task 2), `perms.MentionRoles` (Task 1).
- Produces:
  - `Message.MentionRoles []id.ID` (JSON `mention_roles`, always an array).
  - `func parseRoleMentions(content string, limit int) []id.ID`.
  - `func (s *Service) roleMentionIDs(ctx context.Context, channelID id.ID, content string, anyRole bool, limit int) ([]id.ID, error)`.

- [ ] **Step 1: Write the failing unit test.** Append to `mentions_test.go`:

```go
func TestParseRoleMentions(t *testing.T) {
	cases := []struct {
		in   string
		want []id.ID
	}{
		{"raid <@&123> and <@&456>", []id.ID{123, 456}},
		{"<@&123><@&123>", []id.ID{123}},
		{"`<@&123>` and\n```\n<@&456>\n```", nil},
		{"<@123> <@&abc> @&123", nil},
	}
	for _, c := range cases {
		require.Equal(t, c.want, parseRoleMentions(c.in, maxMentions), c.in)
	}
	var many strings.Builder
	for i := 1; i <= 30; i++ {
		fmt.Fprintf(&many, "<@&%d> ", i)
	}
	require.Len(t, parseRoleMentions(many.String(), maxMentions), 20)
	require.Len(t, parseRoleMentions(many.String(), 3), 3)
	require.Empty(t, parseRoleMentions(many.String(), 0))
}
```

Add the `id` import (`github.com/datrope/datrope/server/internal/id`).

- [ ] **Step 2: Write the failing integration test** `role_mentions_test.go`:

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestRoleMentions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // owner: holds MentionRoles
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	var open, closed struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "mentionable": true}, http.StatusCreated, &open)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &closed)
	tok := func(r id.ID) string { return "<@&" + r.String() + ">" }

	// Anyone may ping a mentionable role; only MentionRoles holders may ping the rest.
	m := bob.Send(general, "raid tonight "+tok(open.ID)+" "+tok(closed.ID))
	require.Equal(t, []id.ID{open.ID}, m.MentionRoles)
	m = alice.Send(general, tok(closed.ID)+" meeting")
	require.Equal(t, []id.ID{closed.ID}, m.MentionRoles)

	// Granting MentionRoles in this channel only, through an @everyone override.
	alice.Do(http.MethodPut, "/api/channels/"+general.String()+"/overrides/role/"+alice.Server().ID.String(),
		map[string]any{"allow": uint64(perms.MentionRoles), "deny": 0}, http.StatusOK, nil)
	require.Equal(t, []id.ID{closed.ID}, carol.Send(general, tok(closed.ID)).MentionRoles)

	// @everyone, unknown roles and code never resolve, and never fail the send.
	m = alice.Send(general, tok(alice.Server().ID)+" "+tok(id.New())+" `"+tok(open.ID)+"`")
	require.Empty(t, m.MentionRoles)
	require.NotNil(t, m.MentionRoles, "always an array")

	// Not in DMs.
	require.Empty(t, alice.Send(dm(t, alice, bob).ID, tok(open.ID)).MentionRoles)

	// Edits re-resolve.
	var edited messages.Message
	alice.Do(http.MethodPatch, "/api/channels/"+general.String()+"/messages/"+m.ID.String(),
		map[string]any{"content": "now " + tok(open.ID)}, http.StatusOK, &edited)
	require.Equal(t, []id.ID{open.ID}, edited.MentionRoles)
}
```

`dm(t, a, b)` is the existing helper used in `inbox_test.go`. Check the edit route in `handlers.go` (around line 235) and match its path and method.

- [ ] **Step 3: Run them and check that they fail.** Run `go test ./internal/messages/ -run "TestParseRoleMentions|TestRoleMentions"`. Expected: compile errors, `parseRoleMentions` and `MentionRoles` are undefined.

- [ ] **Step 4: Implement parsing and resolution in `mentions.go`.**
  - Add to the `var` block:

```go
	roleMentionRe = regexp.MustCompile(`<@&(\d{1,20})>`)
```

  - Add the functions:

```go
// parseRoleMentions returns the role IDs in <@&id> tokens outside code, in
// order, without duplicates, at most limit.
func parseRoleMentions(content string, limit int) []id.ID {
	text := inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " ")
	var out []id.ID
	seen := map[id.ID]bool{}
	for _, m := range roleMentionRe.FindAllStringSubmatch(text, -1) {
		if len(out) >= limit {
			break
		}
		v, err := id.Parse(m[1])
		if err != nil || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// roleMentionIDs resolves the roles content pings in channelID: roles of the
// channel's server other than @everyone, mentionable ones unless anyRole.
// DMs have no server, so they ping no roles.
func (s *Service) roleMentionIDs(ctx context.Context, channelID id.ID, content string, anyRole bool, limit int) ([]id.ID, error) {
	out := []id.ID{}
	ids := parseRoleMentions(content, limit)
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT r.id FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, n)
		JOIN roles r ON r.id = t.id
		JOIN channels c ON c.id = $1 AND c.community_id = r.community_id
		WHERE r.id <> r.community_id AND (r.mentionable OR $3)
		ORDER BY t.n`, channelID, id.Int64s(ids), anyRole)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v id.ID
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
```

  Check `id.Parse`'s signature in `server/internal/id` (it returns `(id.ID, error)`). Check also that a thread channel row carries `community_id`. If it doesn't, change the join to `COALESCE(c.community_id, (SELECT community_id FROM channels p WHERE p.id = c.parent_channel_id))`. The thread case in `TestRoleMentions` is not covered, so add one line: `startThread(...)`, then send with the token, then assert. The `startThread` helper is in `inbox_test.go`.

- [ ] **Step 5: Add the `Message` field** in `messages.go`.
  - After `MentionEveryone`:

```go
	MentionRoles    []id.ID              `json:"mention_roles" doc:"Roles the message pinged; their members are mentioned"`
```

  - Append `, mention_roles` to `messageCols`.
  - In `scanMessage`:
    - Declare `var mentionRoles []int64`.
    - Add `&mentionRoles` to `dest` right after `&m.MentionEveryone` (before `extra...`).
    - After the `m.Mentions` loop, add:

```go
	m.MentionRoles = make([]id.ID, len(mentionRoles))
	for i, v := range mentionRoles {
		m.MentionRoles[i] = id.ID(v)
	}
```

  - Set `MentionRoles: []id.ID{}` in the `Message` literals in `dm_leave.go:57` and `system_post.go:13`.

- [ ] **Step 6: Wire it into create** (`handlers.go`). After `everyone := ...`:

```go
			roles, err := s.roleMentionIDs(ctx, ch.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))
			if err != nil {
				return nil, err
			}
```

  - Add `MentionRoles: roles,` to the `Message` literal.
  - Change the INSERT:

```go
			if _, err := tx.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, mentions, title, mention_everyone, mention_roles) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				m.ID, m.ChannelID, u.ID, m.Content, in.Body.ReplyToID, id.Int64s(mentions), m.Title, everyone, id.Int64s(roles)); err != nil {
```

- [ ] **Step 7: Wire it into edit** (`handlers.go`, about line 256). After `everyone := ...`, add the same `roles, err := s.roleMentionIDs(ctx, ch.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))` block. Then change the UPDATE to set `mention_roles = $7` and pass `id.Int64s(roles)` as the 7th argument:

```go
				UPDATE messages SET content = $2, mentions = $3, edited_at = now(), embed = CASE WHEN $4 THEN NULL ELSE embed END,
					title = COALESCE($5, title), mention_everyone = $6, mention_roles = $7
				WHERE id = $1 AND NOT deleted RETURNING `+messageCols,
				m.ID, content, id.Int64s(mentions), linkChanged, title, everyone, id.Int64s(roles)))
```

- [ ] **Step 8: Wire it into forum posts** (`posts.go`). Resolve against the forum, because the post channel doesn't exist until the transaction commits. After `mentions, err := s.mentionIDs(ctx, content)`:

```go
			roles, err := s.roleMentionIDs(ctx, forum.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))
			if err != nil {
				return nil, err
			}
```

  - Add `MentionRoles: roles` to the literal.
  - Change the INSERT to `(id, channel_id, author_id, content, mentions, mention_everyone, mention_roles) VALUES ($1, $2, $3, $4, $5, $6, $7)` with `id.Int64s(roles)` appended.

- [ ] **Step 9: Wire it into webhooks** (`webhook.go` `PostWebhook`). Webhooks only ping mentionable roles. After `mentions, err := s.resolveMentions(ctx, names)`:

```go
	roles, err := s.roleMentionIDs(ctx, p.ChannelID, p.Content, false, maxMentions-len(mentions))
	if err != nil {
		return nil, err
	}
```

  - Add `MentionRoles: roles` to the literal.
  - Add `mention_roles` as the 9th column / `$9` in the INSERT, with `id.Int64s(roles)`.
  - Update the doc comment: "...other user mentions, and mentionable roles, work as in any message."

- [ ] **Step 10: Add the webhook test.** Append to `server/internal/webhooks/execute_test.go`:

```go
func TestExecutePingsOnlyMentionableRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	var open, closed struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Oncall", "permissions": 0, "mentionable": true}, http.StatusCreated, &open)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &closed)
	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "deploy failed <@&" + open.ID.String() + "> <@&" + closed.ID.String() + ">"}, http.StatusOK, &m)
	require.Equal(t, []id.ID{open.ID}, m.MentionRoles)
}
```

Use whatever status `?wait=true` returns in `TestExecute`, about line 44.

- [ ] **Step 11: Run the tests and check that they pass.** Run `go test ./internal/messages/ ./internal/webhooks/`. Expected: PASS, including all existing tests.

- [ ] **Step 12: Stage.** `git add server/internal/messages server/internal/webhooks`

---

### Task 5: Inbox counts role pings

**Files:**
- Modify: `server/internal/messages/inbox.go:34-35`
- Test: `server/internal/messages/inbox_test.go`

**Interfaces:**
- Consumes: `messages.mention_roles` (Task 4) and `member_roles`.
- Produces: `mentionsWhere` matches role pings for the role's current holders.

- [ ] **Step 1: Write the failing test.** Append to `inbox_test.go`:

```go
func TestMentionsInboxViaRole(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	srv := alice.Server()
	var raid struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Raiders", "permissions": 0, "mentionable": true}, http.StatusCreated, &raid)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+raid.ID.String(), nil, http.StatusNoContent, nil)
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)

	ping := alice.Send(general, "raid <@&"+raid.ID.String()+">")
	alice.Send(secret, "hidden <@&"+raid.ID.String()+">")

	var p messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Equal(t, []id.ID{ping.ID}, itemIDs(p.Items), "role holders are mentioned, but not where they can't read")
	require.Equal(t, 1, *p.UnreadCount)
	carol.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &p)
	require.Empty(t, p.Items, "not a holder")

	var acked messages.AckMentionsResult
	bob.Do(http.MethodPost, "/api/users/@me/mentions/ack", nil, http.StatusOK, &acked)
	require.Len(t, acked.ReadStates, 1)
}
```

- [ ] **Step 2: Run it and check that it fails.** Run `go test ./internal/messages/ -run TestMentionsInboxViaRole`. Expected: FAIL, bob's inbox is empty.

- [ ] **Step 3: Implement.** Replace `mentionsWhere`:

```go
// mentionsWhere: live messages that mention $1 (by name, @everyone or a role $1 holds), by someone else (or a webhook), where $1 can still read them ($2).
var mentionsWhere = `(m.mentions @> ARRAY[$1::bigint] OR m.mention_everyone OR m.mention_roles && ARRAY(SELECT role_id FROM member_roles WHERE user_id = $1)) AND NOT m.deleted AND m.author_id IS DISTINCT FROM $1 AND ` + readableSQL("$2")
```

- [ ] **Step 4: Run the tests and check that they pass.** Run `go test ./internal/messages/`. Expected: PASS.

- [ ] **Step 5: Stage.** `git add server/internal/messages`

---

### Task 6: Client core: schema, API helpers and `mentionsMe`

**Files:**
- Regenerate: `clients/core/openapi.json` and `clients/core/src/schema.d.ts` (with `pnpm -C clients/core gen`)
- Create: `clients/core/src/mentions.ts`
- Test: `clients/core/src/mentions.test.ts`
- Modify: `clients/core/src/index.ts` (add `export * from "./mentions";`)
- Modify: `clients/core/src/store.ts` (`addMention`, about line 273)
- Modify: `clients/core/src/client.ts` (add helpers next to `acceptRules`)

**Interfaces:**
- Consumes: the server API from Tasks 2–5.
- Produces:
  - `mentionsMe(m: MentionFields, meId: string, roleIds: readonly string[]): boolean`.
  - `myRoleIds(s: State): string[]`.
  - `type MentionFields = { mentions?: string[] | null; mention_everyone?: boolean; mention_roles?: string[] | null }`.
  - `client.addMyRole(roleId: string): Promise<void>` and `client.removeMyRole(roleId: string): Promise<void>`.
  - `Role` now has `self_assignable`, `mentionable` and `description`. `Message` has `mention_roles`.

- [ ] **Step 1: Regenerate the schema.** Run `pnpm -C clients/core gen`. Expected: `schema.d.ts` gains `self_assignable`, `mentionable` and `description` on Role, `mention_roles` on Message, and the `/api/server/me/roles/{roleID}` path.

- [ ] **Step 2: Write the failing test** `mentions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mentionsMe } from "./mentions";

describe("mentionsMe", () => {
  it("is true for a direct mention, @everyone, or a role I hold", () => {
    expect(mentionsMe({ mentions: ["1"] }, "1", [])).toBe(true);
    expect(mentionsMe({ mention_everyone: true }, "1", [])).toBe(true);
    expect(mentionsMe({ mention_roles: ["9"] }, "1", ["8", "9"])).toBe(true);
  });
  it("is false otherwise", () => {
    expect(mentionsMe({ mentions: ["2"], mention_roles: ["9"] }, "1", ["8"])).toBe(false);
    expect(mentionsMe({ mentions: null, mention_roles: null }, "1", ["8"])).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and check that it fails.** Run `pnpm -C clients/core test -- mentions`. Expected: FAIL, the module is not found.

- [ ] **Step 4: Implement `mentions.ts`.**

```ts
import type { State } from "./store";

export type MentionFields = { mentions?: string[] | null; mention_everyone?: boolean; mention_roles?: string[] | null };

/** Whether a message pings me: by name, with @everyone, or through a role I hold. */
export function mentionsMe(m: MentionFields, meId: string, roleIds: readonly string[]): boolean {
  return !!m.mentions?.includes(meId) || !!m.mention_everyone || !!m.mention_roles?.some((r) => roleIds.includes(r));
}

const NONE: string[] = [];

/** The roles I hold in the server (not @everyone). Stable when I hold none. */
export function myRoleIds(s: State): string[] {
  return (s.me && s.server?.members[s.me.id]?.role_ids) || NONE;
}
```

  Check that `State` is exported from `store.ts`. If it isn't, export it.

  Add `export * from "./mentions";` to `index.ts`.

- [ ] **Step 5: Use it in the store.** In `store.ts` `addMention`, replace the condition:

```ts
  if (!s.mentions.loaded || !s.me || m.author?.id === s.me.id || !mentionsMe(m, s.me.id, myRoleIds(s))) return s;
```

  Import `mentionsMe` and `myRoleIds` from `./mentions`.

- [ ] **Step 6: Add the API helpers** in `client.ts`, after `acceptRules`:

```ts
  /** Gives me a self-assignable role from the welcome page; MEMBER_UPDATE updates the store. */
  async addMyRole(roleId: string) {
    await unwrap(this.api.PUT("/api/server/me/roles/{roleID}", { params: { path: { roleID: roleId } } }));
  }

  /** Drops a self-assignable role I hold. */
  async removeMyRole(roleId: string) {
    await unwrap(this.api.DELETE("/api/server/me/roles/{roleID}", { params: { path: { roleID: roleId } } }));
  }
```

- [ ] **Step 7: Run the tests and type-check.** Run `pnpm -C clients/core test` and `pnpm -C clients/core exec tsc --noEmit`. Expected: PASS. Fix any test fixture that builds a `Role` or `Message` literal and now misses the required fields: add `self_assignable: false, mentionable: false, description: ""` and `mention_roles: []`.

- [ ] **Step 8: Stage.** `git add clients/core`

---

### Task 7: Rendering role mentions and highlighting messages that ping me

**Files:**
- Modify: `clients/web/src/chat/remarkChat.ts`
- Modify: `clients/web/src/chat/Markdown.tsx` (the `Markdown` component, about lines 92–118)
- Modify: `clients/web/src/app/MessageList.tsx` (lines 296 and 301; pass `roles` at line 484)
- Modify: `clients/web/src/app/InboxButton.tsx:114`
- Modify: `clients/web/src/notify/notify.ts` and `clients/web/src/app/NotificationListener.tsx:53`
- Test: `clients/web/src/chat/Markdown.test.tsx` and the existing notify test file (`clients/web/src/notify/notify.test.ts`, if present)

**Interfaces:**
- Consumes: `mentionsMe` and `myRoleIds` (Task 6), `Message.mention_roles`.
- Produces:
  - `ChatOptions.roles?: Map<string, { name: string; color?: string; me: boolean }>`. Keyed by role ID. It contains only the roles this message actually pinged, or every role when `pinged` is unknown.
  - The `Markdown` prop `roles?: string[]` (the message's `mention_roles`).
  - `NotifyInput.myRoleIds: readonly string[]`.

- [ ] **Step 1: Write the failing test.** Append to `Markdown.test.tsx`:

```ts
describe("role mentions", () => {
  const roles = new Map([["55", { name: "Raid Team", color: "#e74c3c", me: true }], ["66", { name: "Staff", me: false }]]);
  const r = (text: string) => renderToStaticMarkup(<MarkdownView text={text} options={{ ...opts, roles }} />);
  it("renders a pill with the role's name and colour, marked when it pings me", () => {
    expect(r("go <@&55>!")).toContain('<span class="mention" data-role-id="55" style="color:#e74c3c" data-me="">@Raid Team</span>!');
    expect(r("<@&66>")).toContain('<span class="mention" data-role-id="66">@Staff</span>');
  });
  it("shows unknown roles as deleted and leaves code alone", () => {
    expect(r("<@&77>")).toContain('<span class="mention">@deleted-role</span>');
    expect(r("`<@&55>`")).toContain("<code>&lt;@&amp;55&gt;</code>");
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** Run `pnpm -C clients/web test -- Markdown`. Expected: FAIL, because the token renders as plain text.

- [ ] **Step 3: Implement in `remarkChat.ts`.**
  - Add to `ChatOptions`:

```ts
  roles?: Map<string, { name: string; color?: string; me: boolean }>; // by role ID; me = it pinged me
```

  - Extend `TOKEN` with a role alternative first:

```ts
const TOKEN = /(<@&\d{1,20}>|\|\|[\s\S]+?\|\||:[A-Za-z0-9_+-]{2,32}:|(?<![A-Za-z0-9_.@-])@[A-Za-z0-9_.-]{2,})/g;
```

  - At the top of `tokenNodes`:

```ts
  if (token.startsWith("<@&")) {
    const id = token.slice(3, -1);
    const role = o.roles?.get(id);
    const props: Record<string, unknown> = { className: ["mention"] };
    if (role) {
      props["data-role-id"] = id;
      if (role.color) props.style = `color:${role.color}`;
      if (role.me) props["data-me"] = "";
    }
    return [{ type: "chatMention", data: { hName: "span", hProperties: props }, children: [text(role ? "@" + role.name : "@deleted-role")] }];
  }
```

  Check that `renderToStaticMarkup` prints `style="color:#e74c3c"` for a string `style` hProperty. hast-util-to-jsx-runtime parses style strings into objects. If the output differs, adjust the test's expected string to match the actual serialization (e.g. `style="color:#e74c3c"`), not the implementation.

- [ ] **Step 4: Feed the roles in from `Markdown.tsx`.**
  - Add a `roles?: string[]` prop (the message's `mention_roles`).
  - In the component, read `const allRoles = useApp((s) => s.server?.roles);` and `const mine = useApp(myRoleIds);`.
  - Add a `rolesKey = roles?.join(",")` next to `mentionKey`.
  - Add to `options`:

```ts
      roles: new Map(Object.values(allRoles ?? {}).map((r) => [r.id, {
        name: r.name, color: r.color ?? undefined,
        me: !!rolesKey && rolesKey.split(",").includes(r.id) && mine.includes(r.id),
      }])),
```

  - Add `allRoles`, `mine` and `rolesKey` to the `useMemo` deps.
  - Update the doc comment: "`roles` are the role IDs the server resolved; a pill is marked as mine only for those."

- [ ] **Step 5: Pass `roles` and use `mentionsMe` in the callers.**
  - `MessageList.tsx:484`: add `roles={m.pending ? undefined : m.mention_roles ?? undefined}`.
  - `InboxButton.tsx:114`: add `roles={m.mention_roles ?? undefined}`.
  - `MessageList.tsx`: next to `const meId` (line 123), add `const roleIds = useApp(myRoleIds);`. Replace both `mentioned={...}` expressions with `mentioned={!!meId && mentionsMe(m, meId, roleIds)}`. Import both from `@datrope/core`.
  - `notify.ts`:
    - Add `mention_roles?: string[] | null` to `NotifyInput.message`.
    - Add `myRoleIds: readonly string[];` to `NotifyInput`.
    - Replace the "mentions" level line with:

```ts
  if (i.prefs.level === "mentions" && !i.isDM && !mentionsMe(i.message, i.meId, i.myRoleIds)) return false;
```

    - Import `mentionsMe` from `@datrope/core`.
  - `NotificationListener.tsx`: pass `myRoleIds: myRoleIds(s)`.
  - In the notify test file, add `myRoleIds: []` to the base input and this case:

```ts
  it("notifies on a ping of a role I hold at the mentions level", () => {
    expect(shouldNotify({ ...base, prefs: { ...base.prefs, level: "mentions" }, myRoleIds: ["9"],
      message: { ...base.message, mentions: [], mention_roles: ["9"] } })).toBe(true);
  });
```

  Adapt `base` to the name the existing file uses.

- [ ] **Step 6: Run the tests and type-check.** Run `pnpm -C clients/web test` and `pnpm -C clients/web exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 7: Stage.** `git add clients/web/src/chat clients/web/src/app/MessageList.tsx clients/web/src/app/InboxButton.tsx clients/web/src/notify clients/web/src/app/NotificationListener.tsx`

---

### Task 8: Roles in `@` autocomplete

**Files:**
- Modify: `clients/web/src/chat/autocomplete.ts` (add a pure `pingableRoles` helper)
- Modify: `clients/web/src/chat/AutocompleteList.tsx` (`useSuggestions`, mention branch, about lines 37–50)
- Test: `clients/web/src/chat/autocomplete.test.ts`

**Interfaces:**
- Consumes: `Role.mentionable`, `Perm.MentionRoles`, `hasPerm`, `rank`.
- Produces: `pingableRoles(roles: Role[], everyoneId: string, canPingAny: boolean): Role[]`.

- [ ] **Step 1: Write the failing test.** Append to `autocomplete.test.ts`:

```ts
import type { Role } from "@datrope/core";
import { pingableRoles } from "./autocomplete";

const role = (id: string, mentionable: boolean, position: number) =>
  ({ id, name: `r${id}`, permissions: 0, position, hoist: false, self_assignable: false, mentionable, description: "" }) as Role;

describe("pingableRoles", () => {
  const roles = [role("1", false, 0), role("2", true, 1), role("3", false, 2)]; // "1" is @everyone
  it("lists mentionable roles, or every role but @everyone with MENTION_ROLES, senior first", () => {
    expect(pingableRoles(roles, "1", false).map((r) => r.id)).toEqual(["2"]);
    expect(pingableRoles(roles, "1", true).map((r) => r.id)).toEqual(["3", "2"]);
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** Run `pnpm -C clients/web test -- autocomplete`. Expected: FAIL, `pingableRoles` is not exported.

- [ ] **Step 3: Implement it in `autocomplete.ts`.**

```ts
import type { Role } from "@datrope/core";

/** Roles I may ping here, senior first: mentionable ones, or all but @everyone with MENTION_ROLES. */
export function pingableRoles(roles: Role[], everyoneId: string, canPingAny: boolean): Role[] {
  return roles.filter((r) => r.id !== everyoneId && (canPingAny || r.mentionable)).sort((a, b) => b.position - a.position);
}
```

- [ ] **Step 4: Add roles to the suggestions** in `AutocompleteList.tsx`.

  - Next to `canPingEveryone`, add:

```ts
  const canPingRoles = hasPerm(usePerms(channelId), Perm.MentionRoles);
  const roles = useApp(useShallow((s): Role[] => (s.channels[channelId]?.type === "dm" ? [] : Object.values(s.server?.roles ?? {}))));
  const everyoneId = useApp((s) => s.server?.server.id ?? "");
```

  - In the mention branch, compute:

```ts
      const roleHits = rank(q, pingableRoles(roles, everyoneId, canPingRoles).map((r) => ({ key: r.name, r }))).map(({ r }): Suggestion => ({
        id: `role-${r.id}`, insert: `<@&${r.id}> `, text: `@${r.name}`, hint: "Role",
        icon: <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold" aria-hidden="true"
          style={r.color ? { color: r.color } : undefined}>@</span>,
      }));
```

  - Return `[...everyone, ...users, ...roleHits].slice(0, MAX)`, where `users` is the existing user list expression.
  - Add `roles`, `everyoneId` and `canPingRoles` to the `useMemo` deps.
  - Import `Role` and `pingableRoles`.

  Role names may contain spaces, but `findTrigger`'s query stops at a space. So typing `@Raid` finds "Raid Team", which is enough. Rank matches the role name with `q`, and `q` has no spaces.

- [ ] **Step 5: Run the tests and type-check.** Run `pnpm -C clients/web test` and `pnpm -C clients/web exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 6: Stage.** `git add clients/web/src/chat`

---

### Task 9: Role editor controls

**Files:**
- Create: `clients/web/src/app/server-settings/selfAssign.ts`
- Test: `clients/web/src/app/server-settings/selfAssign.test.ts`
- Modify: `clients/web/src/app/server-settings/RoleEditor.tsx`

**Interfaces:**
- Consumes: `selfAssignSafe` and `SELF_ASSIGN_POWER` (Task 1), the Role fields (Task 6).
- Produces: `selfAssignBlocker(role: Role, everyone: boolean, permissions: number): string | null`, which returns the reason the switch is disabled, or null.

- [ ] **Step 1: Write the failing test** `selfAssign.test.ts`:

```ts
import { Perm, type Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { selfAssignBlocker } from "./selfAssign";

const role = { id: "2", name: "Raiders", permissions: 0, position: 1, hoist: false, self_assignable: false, mentionable: false, description: "" } as Role;

describe("selfAssignBlocker", () => {
  it("allows a role without power", () => expect(selfAssignBlocker(role, false, Perm.AttachFiles)).toBeNull());
  it("blocks @everyone, the Guest role and roles with power", () => {
    expect(selfAssignBlocker(role, true, 0)).toMatch(/everyone/);
    expect(selfAssignBlocker({ ...role, is_guest: true }, false, 0)).toMatch(/Guest/);
    expect(selfAssignBlocker(role, false, Perm.Kick)).toMatch(/moderation/);
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** Run `pnpm -C clients/web test -- selfAssign`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `selfAssign.ts`.**

```ts
import { selfAssignSafe, type Role } from "@datrope/core";

/** Why a role can't be self-assignable (mirrors the server's checks), or null if it can. */
export function selfAssignBlocker(role: Role, everyone: boolean, permissions: number): string | null {
  if (everyone) return "Every member already has @everyone.";
  if (role.is_guest) return "The Guest role is given by guest links only.";
  if (!selfAssignSafe(permissions)) return "Roles members pick themselves can't grant moderation, admin or mention permissions.";
  return null;
}
```

- [ ] **Step 4: Wire it into `RoleEditor.tsx`.**
  - Extend `Edits` with `selfAssignable?: boolean; mentionable?: boolean; description?: string;`.
  - Derive the values:

```ts
  const selfAssignable = edits.selfAssignable ?? role.self_assignable;
  const mentionable = edits.mentionable ?? role.mentionable;
  const description = edits.description ?? role.description;
  const blocker = selfAssignBlocker(role, everyone, permissions);
```

  - Add `selfAssignable: selfAssignable !== role.self_assignable, mentionable: mentionable !== role.mentionable, description: description.trim() !== role.description` to `changed`.
  - In `save`'s non-everyone body, add:

```ts
      ...(changed.selfAssignable && { self_assignable: selfAssignable }),
      ...(changed.mentionable && { mentionable }),
      ...(changed.description && { description: description.trim() }),
```

  - In the Display tab, after the hoist `SwitchRow` and before the guest note, add:

```tsx
              <SwitchRow label="Mentionable by anyone" description="Anyone can ping this role with @role. Members with Mention any role can always ping it."
                checked={mentionable} disabled={!editable} onChange={(v) => edit({ mentionable: v })} />
              <SwitchRow label="Self-assignable" description={blocker ?? "Members can give themselves this role on the welcome page."}
                checked={selfAssignable && !blocker} disabled={!editable || !!blocker} onChange={(v) => edit({ selfAssignable: v })} />
              <FormField label="Description" value={description} maxLength={120} disabled={!editable}
                hint="Shown next to the role on the welcome page."
                onChange={(e) => edit({ description: e.target.value })} />
```

  Check `FormField`'s props in `src/components/form-field.tsx`. If it has no `hint` prop, drop it and put the sentence into the label's description in whatever way FormField supports. Don't add a new prop.

  - In the Permissions tab, for a self-assignable role, disable the power toggles. Change the `SwitchRow` there:

```tsx
                const locked = selfAssignable && (flag & SELF_ASSIGN_POWER) !== 0 && !hasPerm(permissions, flag);
                // ...
                    disabled={!editable || locked} ...
                    warning={flag === Perm.Admin ? ADMIN_WARNING : locked ? "Turn off Self-assignable to grant this." : undefined}
```

  Import `SELF_ASSIGN_POWER` from `@datrope/core`.

- [ ] **Step 5: Run the tests and type-check.** Run `pnpm -C clients/web test` and `pnpm -C clients/web exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 6: Stage.** `git add clients/web/src/app/server-settings`

---

### Task 10: Welcome page role picker

**Files:**
- Create: `clients/web/src/app/welcome/selfRoles.ts`
- Test: `clients/web/src/app/welcome/selfRoles.test.ts`
- Create: `clients/web/src/app/welcome/SelfRolePicker.tsx`
- Modify: `clients/web/src/app/welcome/WelcomeView.tsx`

**Interfaces:**
- Consumes: `client.addMyRole` / `client.removeMyRole` and `myRoleIds` (Task 6), `RoleIcon` (`@/components/role-icon`), `Switch`, `ErrorText`.
- Produces: `pickableRoles(roles: Record<string, Role>): Role[]`, which returns the self-assignable roles, senior first. Also the `<SelfRolePicker />` component.

- [ ] **Step 1: Write the failing test** `selfRoles.test.ts`:

```ts
import type { Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { pickableRoles } from "./selfRoles";

const role = (id: string, self_assignable: boolean, position: number) =>
  ({ id, name: id, permissions: 0, position, hoist: false, self_assignable, mentionable: false, description: "" }) as Role;

describe("pickableRoles", () => {
  it("lists self-assignable roles, senior first", () => {
    expect(pickableRoles({ a: role("a", true, 1), b: role("b", false, 2), c: role("c", true, 3) }).map((r) => r.id)).toEqual(["c", "a"]);
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** Run `pnpm -C clients/web test -- selfRoles`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `selfRoles.ts`.**

```ts
import type { Role } from "@datrope/core";

/** The roles members can give themselves, senior first (as in the role list). */
export function pickableRoles(roles: Record<string, Role>): Role[] {
  return Object.values(roles).filter((r) => r.self_assignable).sort((a, b) => b.position - a.position);
}
```

- [ ] **Step 4: Implement `SelfRolePicker.tsx`.**

```tsx
import { isGated, myRoleIds } from "@datrope/core";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorText } from "@/components/error-text";
import { RoleIcon } from "@/components/role-icon";
import { Switch } from "@/components/ui/switch";
import { client, errorText, useApp } from "@/session";
import { pickableRoles } from "./selfRoles";

/** "Pick your roles": switches for the self-assignable roles. Changes save at once. */
export function SelfRolePicker() {
  const roles = useApp(useShallow((s) => pickableRoles(s.server?.roles ?? {})));
  const held = useApp(myRoleIds);
  const gated = useApp(isGated);
  const guest = useApp((s) => !!s.me?.guest_expires_at);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // optimistic state while saving
  const [error, setError] = useState<string>();
  if (guest || roles.length === 0) return null;

  const toggle = async (roleId: string, on: boolean) => {
    setError(undefined);
    setPending((p) => ({ ...p, [roleId]: on }));
    try {
      await (on ? client.addMyRole(roleId) : client.removeMyRole(roleId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(({ [roleId]: _, ...rest }) => rest);
    }
  };

  return (
    <section aria-labelledby="pick-roles" className="grid gap-3">
      <h2 id="pick-roles" className="text-lg font-semibold">Pick your roles</h2>
      {gated && <p className="text-sm text-muted-foreground">Accept the rules to pick roles.</p>}
      <ul className="grid gap-2">
        {roles.map((r) => (
          <RoleRow key={r.id} name={r.name} color={r.color ?? undefined} description={r.description} role={r}
            checked={pending[r.id] ?? held.includes(r.id)} disabled={gated || r.id in pending}
            onChange={(on) => void toggle(r.id, on)} />
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  );
}

function RoleRow({ role, name, color, description, checked, disabled, onChange }: {
  role: Parameters<typeof RoleIcon>[0]["role"]; name: string; color?: string; description: string;
  checked: boolean; disabled: boolean; onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-semibold" style={color ? { color } : undefined}>
          <RoleIcon role={role} className="size-4 text-sm" />{name}
        </span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </li>
  );
}
```

  Notes:
  - Check the guest flag on `User`. `auth.PublicUser.GuestExpiresAt` maps to `guest_expires_at` in the schema. If `me` uses a different field, use that one.
  - Check the `useShallow` import path that `AutocompleteList.tsx` uses, and use the same.
  - The switch's accessible name is the label: the role name plus its description.

- [ ] **Step 5: Render it in `WelcomeView.tsx`.** Inside `<article>`, after the markdown / empty-state expression, add `{welcome && <SelfRolePicker />}` and import it from `./SelfRolePicker`.

- [ ] **Step 6: Run the tests and type-check.** Run `pnpm -C clients/web test` and `pnpm -C clients/web exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 7: Check it in the browser.** Start the dev server (`.claude/launch.json` entry `datrope-web` / `datrope-server`). As the owner, mark a role self-assignable in Server settings → Roles. Open #welcome and confirm "Pick your roles" shows it. Toggle it on, and confirm the role shows on your profile. Take a screenshot.

- [ ] **Step 8: Stage.** `git add clients/web/src/app/welcome`

---

### Task 11: End-to-end flow

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (append a test after "announcement, forum and gallery channels"; it runs after the first test, so alice is the owner and bob is a member who accepted the rules)

**Interfaces:**
- Consumes: everything above, through the UI.

- [ ] **Step 1: Write the test.**

```ts
// Runs after the first test: alice owns the server and bob is a member who accepted the rules.
test("members pick roles on the welcome page, which unlock channels and can be pinged", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await signIn(alice, "alice");
  const bob = await (await browser.newContext()).newPage();
  await signIn(bob, "bob");

  // alice creates a self-assignable, mentionable role and a channel only it can see (setup through the API).
  const role = await (await alice.request.post("/api/server/roles", {
    data: { name: "Raiders", permissions: 0, self_assignable: true, mentionable: true, description: "Raid nights on Friday" },
  })).json() as { id: string };
  const server = await (await alice.request.get("/api/server")).json() as { id: string };
  const raids = await (await alice.request.post("/api/server/channels", { data: { name: "raids", type: "text" } })).json() as { id: string };
  expect((await alice.request.put(`/api/channels/${raids.id}/overrides/role/${server.id}`, { data: { allow: 0, deny: 1 } })).ok()).toBe(true);
  expect((await alice.request.put(`/api/channels/${raids.id}/overrides/role/${role.id}`, { data: { allow: 1, deny: 0 } })).ok()).toBe(true);

  // bob picks the role on the welcome page and #raids appears.
  await expect(bob.getByRole("link", { name: "raids" })).toHaveCount(0);
  await bob.getByRole("link", { name: "welcome" }).click();
  await bob.getByRole("switch", { name: /Raiders/ }).click();
  await expect(bob.getByRole("switch", { name: /Raiders/ })).toBeChecked();
  await expect(bob.getByRole("link", { name: "raids" })).toBeVisible();

  // alice pings the role from autocomplete; bob sees it as a mention of him.
  await alice.getByRole("link", { name: "raids" }).click();
  await alice.getByLabel("Message", { exact: true }).fill("tonight @Raid");
  await alice.getByRole("option", { name: /@Raiders/ }).click();
  await alice.getByLabel("Message", { exact: true }).press("Enter");
  await bob.getByRole("link", { name: "raids" }).click();
  const msg = bob.getByRole("main", { name: "# raids" }).getByRole("article").filter({ hasText: "tonight" });
  await expect(msg.locator('.mention[data-me]')).toHaveText("@Raiders");
  await bob.getByRole("button", { name: "Inbox" }).click();
  await expect(bob.getByRole("dialog", { name: "Inbox" }).getByText("@Raiders")).toBeVisible();
});
```

Notes:
- The deny/allow value `1` is `Perm.ViewChannel`.
- The REST paths must match `server/internal/channels/handlers.go:270`. The channel-create path and body must match what `createChannel` in this spec sends; check `/api/server/channels` in `webhook_messages_test.go`.
- If the inbox popover's role isn't `dialog`, use the locator the first test uses for the Inbox.
- `AutocompleteList` renders `option`s; check the role names it uses.

- [ ] **Step 2: Run the e2e suite** against a fresh stack, following the local e2e notes: `down -v`, then `up -d --build --wait` with the local-ports override, then `pnpm -C clients/web exec playwright test`. Expected: all tests PASS. Fix selectors to match the real accessible names, not the other way round.

- [ ] **Step 3: Run the whole server suite** from PowerShell: `cd server; $env:GOTOOLCHAIN='local'; go test ./...`. Expected: PASS.

- [ ] **Step 4: Stage.** `git add clients/web/e2e/chat.spec.ts`. Then report to the user, with a suggested commit message.
