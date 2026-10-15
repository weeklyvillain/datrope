# Batch C (upload TTL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- An instance admin sets size tiers, such as "files over 500 MB are deleted after 7 days".
- Large uploads then expire automatically. Their uploader, or a moderator, can keep a file forever or remove it early (item 9).

**Architecture:**
- **Rules:** they live in a new `instance_settings.upload_ttl_rules` jsonb column.
- **Expiry date:** `files.Claim` stamps `attachments.expires_at` when a message is sent.
- **Sweep:** the existing hourly `files.Sweep` marks expired rows (`expired_at`) and removes blobs that nothing else references. A blob still used by another attachment survives.
  - Expired rows stop counting as references in `removeIfUnused`.
  - A callback publishes `MESSAGE_UPDATE`.
- **Download:** an expired file answers 410.
- **Galleries:** they hide expired files.
- **Keep and remove:** new `PATCH` / `DELETE /api/attachments/{id}` endpoints live in the messages package, which already has the channel access and rank checks and `publishUpdated`.

**Tech Stack:** Go (huma, pgx, goose), apptest with Postgres in Docker, React 18, Vitest in node.

**Spec:** `docs/superpowers/specs/2026-10-14-multi-features-design.md`, section C4.

## Rulings (made while planning)

1. **"Allow expiry" counts from now.** Turning `keep` off sets `expires_at = now() + ttl` from the current rules, not from the upload time. Otherwise an old file would vanish within the hour of clicking it. If no rule matches, `expires_at` becomes null and the file stays.
2. **Keep and remove are message-level in the UI.** The menus act on all of the message's attachments that the action applies to, and the API is still per attachment. The gallery FileMenu gets no new actions; you go to the message instead. The cost is one extra click for gallery users.
3. **The permission check equals message delete:** the uploader, or `ManageMessages` plus outranking the uploader (not needed in DMs). The client reuses the message row's `canDelete`, because the author is always the uploader.

## Global Constraints

- Never commit (AGENTS.md §5). Stage only.
- Never hardcode colors. Keep accessible names stable.
- Vitest runs in node. Go tests need Docker; use `GOTOOLCHAIN=local`. `rtk` is not on subagents' PATH.
- The migration is `00045_upload_ttl.sql`. `00044` is taken by the voice plan; if that plan has not run yet, still use `00045`. Goose applies migrations in order, and a gap is fine.
- Rules: at most 5. `min_bytes` is at least 1048576 (1 MB) and unique. `ttl_hours` is 1–8760. The tier with the largest `min_bytes` that is ≤ size wins. An empty list means the feature is off.
- Only new messages get an expiry. Existing files stay permanent.
- An expired file returns 410 `FILE_EXPIRED` on download, and its message stays.

## Review Focus

1. **Deduplicated blobs.** Two attachments share a blob, and one expires. The blob must survive, because the other attachment still references it. Covered by a test in Task 2.
2. **The rules change after a send.** The file keeps the `expires_at` it was stamped with. Covered by a test in Task 2.
3. **Keep, then the sweep.** A kept file never expires, even past `expires_at`. Covered by a test in Task 2.
4. **A stranger, or a moderator who doesn't outrank, tries keep or remove on someone else's file.** They get 403. Covered by a test in Task 3.
5. **The gallery and albums after expiry.** Expired files disappear from `/api/files` and album listings. Covered by a test in Task 2.

---

### Task 1: The TTL rules setting (server plus admin UI)

**Files:**
- Create: `server/internal/db/migrations/00045_upload_ttl.sql`
- Modify: `server/internal/auth/store.go:77-83` (`Settings`), and `:290-302` (`Settings()` and `UpdateSettings`)
- Modify: `server/internal/auth/admin.go` (`UpdateSettingsRequest` and the PATCH handler)
- Modify: `server/internal/auth/admin_test.go:30` (the expected struct gets `UploadTTLRules: []auth.TTLRule{}`)
- Test: `server/internal/auth/ttl_rules_test.go`
- Modify: `clients/web/src/app/server-settings/Uploads.tsx` (the rules editor)
- Create: `clients/web/src/app/server-settings/ttl-rules.ts`
- Test: `clients/web/src/app/server-settings/ttl-rules.test.ts`

**Interfaces:**
- Produces, Go: `type TTLRule struct { MinBytes int64 \`json:"min_bytes"\`; TTLHours int \`json:"ttl_hours"\` }` and `Settings.UploadTTLRules []TTLRule \`json:"upload_ttl_rules"\``. The value is never nil; it is an empty slice when unset.
- Produces, JSON: PATCH `/api/admin/settings` accepts `upload_ttl_rules: [{min_bytes, ttl_hours}]`.
- Produces, TS:
  - `rowsFromRules(rules): Row[]`, where `Row = { mb: number; days: number }`;
  - `rulesFromRows(rows): TTLRule[]`;
  - `rowsError(rows): string | null`.

- [ ] **Step 1: Write the failing Go test**

`server/internal/auth/ttl_rules_test.go`:

```go
package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func TestUploadTTLRules(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var set auth.Settings
	admin.Do(http.MethodGet, "/api/admin/settings", nil, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{}, set.UploadTTLRules)

	rules := []map[string]any{{"min_bytes": 100 << 20, "ttl_hours": 24 * 30}, {"min_bytes": 500 << 20, "ttl_hours": 24 * 7}}
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": rules}, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{{MinBytes: 100 << 20, TTLHours: 720}, {MinBytes: 500 << 20, TTLHours: 168}}, set.UploadTTLRules)

	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 1000, "ttl_hours": 1}}}, http.StatusBadRequest, "VALIDATION_FAILED")
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 2 << 20, "ttl_hours": 1}, {"min_bytes": 2 << 20, "ttl_hours": 2}}}, http.StatusBadRequest, "VALIDATION_FAILED")
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 2 << 20, "ttl_hours": 9000}}}, http.StatusBadRequest, "VALIDATION_FAILED")

	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{}}, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{}, set.UploadTTLRules)
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/auth -run TTL`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

`00045_upload_ttl.sql`:

```sql
-- +goose Up
-- Size tiers after which sent files are deleted ([{min_bytes, ttl_hours}]; empty: never), and each file's
-- expiry: when it goes (stamped at send), whether someone chose to keep it, and when it went.
ALTER TABLE instance_settings ADD COLUMN upload_ttl_rules JSONB NOT NULL DEFAULT '[]';
ALTER TABLE attachments
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN keep BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN expired_at TIMESTAMPTZ;
CREATE INDEX attachments_expiry_idx ON attachments (expires_at) WHERE expired_at IS NULL AND NOT keep AND expires_at IS NOT NULL;

-- +goose Down
DROP INDEX attachments_expiry_idx;
ALTER TABLE attachments DROP COLUMN expired_at, DROP COLUMN keep, DROP COLUMN expires_at;
ALTER TABLE instance_settings DROP COLUMN upload_ttl_rules;
```

In `store.go`:
- Add:

```go
// TTLRule deletes sent files of at least MinBytes TTLHours after they were sent.
type TTLRule struct {
	MinBytes int64 `json:"min_bytes" minimum:"1048576"`
	TTLHours int   `json:"ttl_hours" minimum:"1" maximum:"8760"`
}
```

- Add `UploadTTLRules []TTLRule \`json:"upload_ttl_rules" doc:"Size tiers after which sent files are deleted; empty: files are kept"\`` to `Settings`.
- In `Settings()`, select `upload_ttl_rules` into a `[]byte`, then `json.Unmarshal` it. If the result is nil, set `x.UploadTTLRules = []TTLRule{}`.
- `UpdateSettings` also sets `upload_ttl_rules = $3`, with `json.Marshal(x.UploadTTLRules)`.

In `admin.go`:
- Add `UploadTTLRules *[]TTLRule \`json:"upload_ttl_rules,omitempty" maxItems:"5"\`` to `UpdateSettingsRequest`.
- In the handler, before `UpdateSettings`:

```go
			if in.Body.UploadTTLRules != nil {
				rules := *in.Body.UploadTTLRules
				seen := map[int64]bool{}
				for _, r := range rules {
					if seen[r.MinBytes] {
						return nil, httpx.BadRequest("VALIDATION_FAILED", "two rules have the same size")
					}
					seen[r.MinBytes] = true
				}
				slices.SortFunc(rules, func(a, b TTLRule) int { return cmp.Compare(a.MinBytes, b.MinBytes) })
				set.UploadTTLRules = rules
			}
```

Huma enforces `minimum`/`maximum` on the nested fields. Check with the 1000-byte case. If huma doesn't validate nested array items, add explicit checks that return `VALIDATION_FAILED`.

In `admin_test.go:30`, add `UploadTTLRules: []auth.TTLRule{}` to the expected value.

- [ ] **Step 4: Run it and watch it pass**

Run: `GOTOOLCHAIN=local go -C server test ./internal/auth`
Expected: PASS.

- [ ] **Step 5: Write the failing TS test for the admin editor helpers**

`clients/web/src/app/server-settings/ttl-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rowsError, rowsFromRules, rulesFromRows } from "./ttl-rules";

const MB = 1024 * 1024;

describe("ttl rules editor", () => {
  it("shows rules as MB and days", () =>
    expect(rowsFromRules([{ min_bytes: 500 * MB, ttl_hours: 168 }])).toEqual([{ mb: 500, days: 7 }]));
  it("saves rows as bytes and hours", () =>
    expect(rulesFromRows([{ mb: 500, days: 7 }])).toEqual([{ min_bytes: 500 * MB, ttl_hours: 168 }]));
  it("explains bad rows", () => {
    expect(rowsError([{ mb: 500, days: 7 }])).toBeNull();
    expect(rowsError([{ mb: 0, days: 7 }])).toBe("Sizes start at 1 MB.");
    expect(rowsError([{ mb: 5, days: 0 }])).toBe("Keep files at least 1 day.");
    expect(rowsError([{ mb: 5, days: 400 }])).toBe("Keep files at most 365 days.");
    expect(rowsError([{ mb: 5, days: 1 }, { mb: 5, days: 2 }])).toBe("Each size can have only one rule.");
    expect(rowsError(Array(6).fill({ mb: 1, days: 1 }).map((r, i) => ({ ...r, mb: i + 1 })))).toBe("At most 5 rules.");
  });
});
```

Run: `pnpm exec vitest run src/app/server-settings/ttl-rules.test.ts` (from clients/web)
Expected: FAIL.

- [ ] **Step 6: Implement the helpers and the editor**

`ttl-rules.ts`:

```ts
const MB = 1024 * 1024;
export type TTLRule = { min_bytes: number; ttl_hours: number };
export type Row = { mb: number; days: number };

export const rowsFromRules = (rules: TTLRule[]): Row[] =>
  rules.map((r) => ({ mb: Math.round(r.min_bytes / MB), days: Math.max(1, Math.round(r.ttl_hours / 24)) }));

export const rulesFromRows = (rows: Row[]): TTLRule[] => rows.map((r) => ({ min_bytes: r.mb * MB, ttl_hours: r.days * 24 }));

/** Why these rows can't be saved, or null. */
export function rowsError(rows: Row[]): string | null {
  if (rows.length > 5) return "At most 5 rules.";
  if (rows.some((r) => !(r.mb >= 1))) return "Sizes start at 1 MB.";
  if (rows.some((r) => !(r.days >= 1))) return "Keep files at least 1 day.";
  if (rows.some((r) => r.days > 365)) return "Keep files at most 365 days.";
  if (new Set(rows.map((r) => r.mb)).size !== rows.length) return "Each size can have only one rule.";
  return null;
}
```

In `Uploads.tsx`, add a section after the "Uploads" section, headed "Automatic deletion" (`<h3 id="ttl-h">`).
- Explain in muted text: "Large files take up space. Sent files at least this big are deleted after the time you set. Their messages stay, and the uploader or a moderator can keep a file forever. Applies to files sent from now on."
- Load: in the existing GET effect, also keep `rows = rowsFromRules(s.upload_ttl_rules)`.
- Each row, as a flex row: "Files over" then `<Input type="number" aria-label={\`Rule ${i+1} size in MB\`} …/>` then "MB are deleted after" then `<Input type="number" aria-label={\`Rule ${i+1} days\`} …/>` then "days", and a ghost icon `Button` with `aria-label={\`Remove rule ${i+1}\`}` showing `<X />`.
- "Add rule" is an outline button, disabled at 5 rules. A new row is `{ mb: 100, days: 30 }`.
- "Save rules" is the submit button. It runs `PATCH /api/admin/settings { upload_ttl_rules: rulesFromRows(rows) }`, and is disabled while `rowsError(rows)` returns a message. Show the error text, and a "Saved" status.
- With no rows, show "No rules: files are kept until someone deletes their message."

- [ ] **Step 7: Regenerate the types, typecheck, and stage**

From clients/core, run `pnpm run gen`. Then run `pnpm exec vitest run src/app/server-settings && pnpm exec tsc -p tsconfig.json` from clients/web.
Expected: PASS.

```bash
git add server/internal/db/migrations/00045_upload_ttl.sql server/internal/auth clients/core/openapi.json clients/core/src/schema.d.ts clients/web/src/app/server-settings/Uploads.tsx clients/web/src/app/server-settings/ttl-rules.ts clients/web/src/app/server-settings/ttl-rules.test.ts
```

---

### Task 2: Stamping, sweeping and serving expiry (files)

**Files:**
- Modify: `server/internal/files/files.go`:
  - the `Attachment` struct, `attachmentCols` and `scanAttachment` (:122-138);
  - `Sweep` (:285);
  - `removeIfUnused` (:342);
  - `authorized` (:148);
  - a new `OnExpired` hook.
- Create: `server/internal/files/ttl.go` (`TTLFor` and the expire helpers)
- Modify: `server/internal/files/claim.go` (`Claim` stamps `expires_at`)
- Modify: `server/internal/messages/files.go:106-110` (gallery conditions get `a.expired_at IS NULL`)
- Modify: `server/internal/albums/items.go:41`, `albums.go:228-231` and `:344-351` (exclude expired)
- Modify: `server/internal/messages/previews.go` (export `PublishUpdated`)
- Modify: `server/internal/app/app.go` (after `msgSvc` exists: `filesSvc.SetOnExpired(msgSvc.PublishUpdated)`)
- Test: `server/internal/files/ttl_test.go`

**Interfaces:**
- Consumes: `auth.Settings.UploadTTLRules` and `auth.TTLRule` (Task 1).
- Produces, JSON on `Attachment`:
  - `expires_at` (time, omitted when none);
  - `keep` (bool);
  - `expired` (bool). An expired attachment's `url` and `thumbnail_url` are empty.
- Produces, Go:
  - `func TTLFor(rules []auth.TTLRule, size int64) (time.Duration, bool)`;
  - `func (s *Service) SetOnExpired(fn func(ctx context.Context, channelID, messageID id.ID))`;
  - `func (s *Service) Get(ctx context.Context, id id.ID) (*Attachment, error)` (exported);
  - `func (s *Service) SetKeep(ctx context.Context, a *Attachment, keep bool) error`;
  - `func (s *Service) ExpireNow(ctx context.Context, a *Attachment) error`;
  - `func (s *Service) PublishUpdated(ctx context.Context, channelID, messageID id.ID)` in messages.

- [ ] **Step 1: Write the failing tests**

`server/internal/files/ttl_test.go`:

```go
package files_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
)

const mb = 1 << 20

func TestTTLFor(t *testing.T) {
	rules := []auth.TTLRule{{MinBytes: 100 * mb, TTLHours: 720}, {MinBytes: 500 * mb, TTLHours: 168}}
	_, ok := files.TTLFor(rules, 99*mb)
	require.False(t, ok)
	d, ok := files.TTLFor(rules, 100*mb)
	require.True(t, ok)
	require.Equal(t, 720*time.Hour, d)
	d, _ = files.TTLFor(rules, 900*mb)
	require.Equal(t, 168*time.Hour, d, "the biggest matching tier wins")
	_, ok = files.TTLFor(nil, 900*mb)
	require.False(t, ok)
}

func TestUploadExpires(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": mb, "ttl_hours": 24}}}, http.StatusOK, nil)

	big := bytes.Repeat([]byte("x"), mb+10)
	a := alice.Upload(ch, "big.bin", big, http.StatusCreated)
	m := alice.SendWith(ch, "here", a.ID)
	require.NotNil(t, m.Attachments[0].ExpiresAt)
	require.WithinDuration(t, time.Now().Add(24*time.Hour), *m.Attachments[0].ExpiresAt, time.Minute)

	small := alice.SendWith(ch, "tiny", alice.Upload(ch, "s.txt", []byte("hi"), http.StatusCreated).ID)
	require.Nil(t, small.Attachments[0].ExpiresAt)

	// The same bytes again, kept forever: their shared blob must survive the first one expiring.
	b := alice.Upload(ch, "copy.bin", big, http.StatusCreated)
	mb2 := alice.SendWith(ch, "copy", b.ID)
	alice.Do(http.MethodPatch, "/api/attachments/"+b.ID.String(), map[string]any{"keep": true}, http.StatusOK, nil)

	// Changing the rules later does not touch files already sent.
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{}}, http.StatusOK, nil)

	bobWS, _ := bob.Connect()
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	var upd struct {
		ID          string             `json:"id"`
		Attachments []files.Attachment `json:"attachments"`
	}
	bobWS.ExpectDispatch("MESSAGE_UPDATE", &upd)
	require.Equal(t, m.ID.String(), upd.ID)
	require.True(t, upd.Attachments[0].Expired)
	require.Empty(t, upd.Attachments[0].URL)

	alice.Fail(http.MethodGet, a.URL, nil, http.StatusGone, "FILE_EXPIRED")
	alice.Raw(http.MethodGet, mb2.Attachments[0].URL, nil, "", http.StatusOK) // kept: still there
	require.Equal(t, 2, blobCount(t, env))                                   // the shared blob and the small one

	var page struct {
		Items []struct {
			Attachment files.Attachment `json:"attachment"`
		} `json:"items"`
	}
	alice.Do(http.MethodGet, "/api/files?channel_id="+ch.String(), nil, http.StatusOK, &page)
	for _, it := range page.Items {
		require.NotEqual(t, a.ID, it.Attachment.ID, "the gallery hides expired files")
	}
}
```

The test uses the keep endpoint from Task 3, so it fails in this task until Task 3 lands. In this task, set keep directly instead: `env.Pool.Exec(ctx, "UPDATE attachments SET keep = true WHERE id = $1", b.ID)`. Task 3 then swaps that line back to the API call.

Check:
- the real query parameters and response shape of `/api/files`, in `messages/files.go:235-290`;
- the `Fail` helper's handling of non-JSON 410 bodies (download errors go through `httpx.WriteHTTPError`, which writes JSON);
- adapt as needed.

- [ ] **Step 2: Run them and watch them fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/files -run 'TTLFor|UploadExpires'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

`ttl.go`:

```go
package files

import (
	"context"
	"time"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
)

// TTLFor is how long a sent file of `size` bytes lives: the tier with the biggest MinBytes not above size.
func TTLFor(rules []auth.TTLRule, size int64) (time.Duration, bool) {
	best := -1
	for i, r := range rules {
		if r.MinBytes <= size && (best < 0 || r.MinBytes > rules[best].MinBytes) {
			best = i
		}
	}
	if best < 0 {
		return 0, false
	}
	return time.Duration(rules[best].TTLHours) * time.Hour, true
}

// SetOnExpired is told about each message whose files the sweep expired (it publishes MESSAGE_UPDATE).
func (s *Service) SetOnExpired(fn func(ctx context.Context, channelID, messageID id.ID)) { s.onExpired = fn }

// Get is an attachment by ID (any state).
func (s *Service) Get(ctx context.Context, attachmentID id.ID) (*Attachment, error) { return s.get(ctx, attachmentID) }

// SetKeep keeps a sent file forever, or lets it expire again by the current rules, counted from now.
func (s *Service) SetKeep(ctx context.Context, a *Attachment, keep bool) error {
	if keep {
		_, err := s.db.Exec(ctx, `UPDATE attachments SET keep = true WHERE id = $1 AND expired_at IS NULL`, a.ID)
		return err
	}
	set, err := s.settings.Settings(ctx)
	if err != nil {
		return err
	}
	var at *time.Time
	if d, ok := TTLFor(set.UploadTTLRules, a.Size); ok {
		t := time.Now().Add(d)
		at = &t
	}
	_, err = s.db.Exec(ctx, `UPDATE attachments SET keep = false, expires_at = $2 WHERE id = $1 AND expired_at IS NULL`, a.ID, at)
	return err
}

// ExpireNow removes a sent file's contents at once (its row and message stay, marked expired).
func (s *Service) ExpireNow(ctx context.Context, a *Attachment) error {
	return s.expire(ctx, `UPDATE attachments SET expired_at = now() WHERE id = $1 AND expired_at IS NULL
		RETURNING channel_id, message_id, sha256, thumb_sha256`, a.ID)
}

// expire marks rows expired with `q` and removes the blobs nothing else references.
func (s *Service) expire(ctx context.Context, q string, args ...any) error {
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return err
	}
	type ref struct{ ch, msg id.ID }
	var refs []ref
	var sums []string
	for rows.Next() {
		var ch, msg int64
		var sum string
		var thumb *string
		if err := rows.Scan(&ch, &msg, &sum, &thumb); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, ref{id.ID(ch), id.ID(msg)})
		sums = append(sums, sum)
		if thumb != nil {
			sums = append(sums, *thumb)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := s.removeUnreferenced(ctx, sums); err != nil {
		return err
	}
	if s.onExpired != nil {
		seen := map[ref]bool{}
		for _, r := range refs {
			if !seen[r] {
				seen[r] = true
				s.onExpired(ctx, r.ch, r.msg)
			}
		}
	}
	return nil
}
```

In `files.go`:
- Add the field `onExpired func(ctx context.Context, channelID, messageID id.ID)` to `Service`.
- `Attachment` gets:

```go
	ExpiresAt *time.Time `json:"expires_at,omitempty" doc:"When the file will be deleted (size rules); absent: kept"`
	Keep      bool       `json:"keep" doc:"Someone chose to keep it past the size rules"`
	Expired   bool       `json:"expired" doc:"Deleted by the size rules or by hand; the message stays"`
```

- `attachmentCols` gets `, expires_at, keep, expired_at IS NOT NULL` appended. `scanAttachment` scans `&a.ExpiresAt, &a.Keep, &a.Expired` after `&a.GIF`.
- `setURLs`: if `a.Expired`, set `a.URL, a.ThumbnailURL = "", ""` and return. Call it after the expired fields are scanned, which is already the order.
- `Sweep`: before the `store.Walk`, add:

```go
	if err := s.expire(ctx, `UPDATE attachments SET expired_at = $1
		WHERE expired_at IS NULL AND NOT keep AND expires_at IS NOT NULL AND expires_at < $1
		RETURNING channel_id, message_id, sha256, thumb_sha256`, now); err != nil {
		return err
	}
```

- `removeIfUnused`: the attachments clause becomes `SELECT EXISTS (SELECT 1 FROM attachments WHERE (sha256 = $1 OR thumb_sha256 = $1) AND expired_at IS NULL)`. An expired row no longer keeps its blob alive.
- `authorized`: after loading `a`, add `if a.Expired { return nil, httpx.E(http.StatusGone, "FILE_EXPIRED", "this file was deleted") }`. Do it after the access checks, so the 410 never reveals files in channels you can't read. Move it to just before `return a, nil` in both branches.

In `claim.go`, after the `rows.Err()` check in `Claim` and before the count check:

```go
	set, err := s.settings.Settings(ctx)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if d, ok := TTLFor(set.UploadTTLRules, out[i].Size); ok {
			at := time.Now().Add(d)
			if _, err := tx.Exec(ctx, `UPDATE attachments SET expires_at = $2 WHERE id = $1`, out[i].ID, at); err != nil {
				return nil, err
			}
			out[i].ExpiresAt = &at
		}
	}
```

Galleries:
- `messages/files.go`: add `"a.expired_at IS NULL"` to `conds`.
- `albums/items.go:41`: add `"a.expired_at IS NULL"` to `conds`.
- `albums.go`: add `AND t.expired_at IS NULL` to the deck query (:228-231), and to `inScope` (:344-351), so expired files can't be added to albums.

`messages/previews.go`: add `func (s *Service) PublishUpdated(ctx context.Context, channelID, messageID id.ID) { s.publishUpdated(ctx, channelID, messageID) }`.

`app.go`: after `msgSvc := messages.NewService(...)`, add `filesSvc.SetOnExpired(msgSvc.PublishUpdated)`. `filesSvc` can be nil when there is no data dir, so guard it the way the surrounding code does.

- [ ] **Step 4: Run them and watch them pass**

Run: `GOTOOLCHAIN=local go -C server test ./internal/files ./internal/messages ./internal/albums`
Expected: PASS, including the existing Sweep and gallery tests.

- [ ] **Step 5: Regenerate the types and stage**

From clients/core, run `pnpm run gen`, then `corepack pnpm -r typecheck`.

```bash
git add server/internal/files server/internal/messages server/internal/albums server/internal/app/app.go clients/core/openapi.json clients/core/src/schema.d.ts
```

---

### Task 3: Keep and remove endpoints (server)

**Files:**
- Create: `server/internal/messages/attachments.go`
- Modify: `server/internal/messages/handlers.go` (register; see `Register`)
- Modify: the `Attachments` interface in the messages package (wherever it is declared) to include `Get`, `SetKeep` and `ExpireNow`
- Test: `server/internal/messages/attachment_actions_test.go`
- Modify: `server/internal/files/ttl_test.go` (use the API for keep, as noted in Task 2)

**Interfaces:**
- Consumes: `files.Service.Get`, `SetKeep` and `ExpireNow` (Task 2).
- Produces:
  - `PATCH /api/attachments/{id}` with body `{"keep": bool}`, returning `200` and the updated `files.Attachment`;
  - `DELETE /api/attachments/{id}`, returning `204`;
  - both publish `MESSAGE_UPDATE`.

- [ ] **Step 1: Write the failing test**

`attachment_actions_test.go`:

```go
package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func TestAttachmentKeepAndRemove(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	_ = env
	a := bob.Upload(ch, "notes.txt", []byte("hello"), http.StatusCreated)
	bob.SendWith(ch, "file", a.ID)
	path := "/api/attachments/" + a.ID.String()

	var got files.Attachment
	bob.Do(http.MethodPatch, path, map[string]any{"keep": true}, http.StatusOK, &got)
	require.True(t, got.Keep)

	carol := env.Register("carol")
	carol.Join(alice.Invite())
	carol.Fail(http.MethodPatch, path, map[string]any{"keep": false}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodDelete, path, nil, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodPatch, path, map[string]any{"keep": false}, http.StatusOK, &got) // the owner outranks bob
	require.False(t, got.Keep)

	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodGet, a.URL, nil, http.StatusGone, "FILE_EXPIRED")
	bob.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil) // already gone: no-op

	draft := bob.Upload(ch, "draft.txt", []byte("x"), http.StatusCreated)
	bob.Fail(http.MethodPatch, "/api/attachments/"+draft.ID.String(), map[string]any{"keep": true}, http.StatusNotFound, "NOT_FOUND")
}
```

Here alice is the owner and has ManageMessages, and bob is a plain member. Carol is a plain member who doesn't outrank bob. Check that plain members lack ManageMessages by default; `perms.Default` should not include it.

- [ ] **Step 2: Run it and watch it fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/messages -run AttachmentKeep`
Expected: FAIL (404 on the routes).

- [ ] **Step 3: Implement**

`attachments.go`:

```go
package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/perms"
)

type KeepRequest struct {
	Keep bool `json:"keep" doc:"true: never delete it by the size rules; false: let them apply again (counted from now)"`
}

// sentFileFor loads a sent attachment the caller may manage: their own, or (MANAGE_MESSAGES) someone they
// outrank; DMs need no outranking. The same rule as deleting the message.
func (s *Service) sentFileFor(ctx context.Context, raw string) (*files.Attachment, *channels.Channel, error) {
	aid, err := httpx.ParseID(raw, "attachment")
	if err != nil {
		return nil, nil, err
	}
	a, err := s.attachments.Get(ctx, aid)
	if err != nil {
		return nil, nil, err
	}
	if a.MessageID() == nil || a.ChannelID == nil {
		return nil, nil, httpx.NotFound("attachment")
	}
	me := auth.Current(ctx).User.ID
	ch, have, err := s.channels.Access(ctx, me, *a.ChannelID, perms.ReadHistory)
	if err != nil {
		return nil, nil, httpx.NotFound("attachment")
	}
	if a.UploaderID() == me {
		return a, ch, nil
	}
	if !have.Has(perms.ManageMessages) {
		return nil, nil, httpx.MissingPermission()
	}
	if ch.Type != channels.TypeDM {
		ok, err := s.ranks.Outranks(ctx, me, a.UploaderID())
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, httpx.MissingPermission()
		}
	}
	return a, ch, nil
}

func registerAttachmentActions(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	type path struct {
		ID string `path:"id"`
	}
	huma.Register(api, op("keep-attachment", http.MethodPatch, "/api/attachments/{id}", 0),
		func(ctx context.Context, in *struct {
			path
			Body KeepRequest
		}) (*struct{ Body *files.Attachment }, error) {
			a, ch, err := s.sentFileFor(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if err := s.attachments.SetKeep(ctx, a, in.Body.Keep); err != nil {
				return nil, err
			}
			if a, err = s.attachments.Get(ctx, a.ID); err != nil {
				return nil, err
			}
			s.publishUpdated(ctx, ch.ID, *a.MessageID())
			return &struct{ Body *files.Attachment }{a}, nil
		})
	huma.Register(api, op("remove-attachment", http.MethodDelete, "/api/attachments/{id}", http.StatusNoContent),
		func(ctx context.Context, in *path) (*struct{}, error) {
			a, _, err := s.sentFileFor(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			return nil, s.attachments.ExpireNow(ctx, a) // publishes MESSAGE_UPDATE through the expiry hook
		})
}
```

Check the details against the real code:
- The `op` helper's signature in messages `Register`, and how the channel-access function is named there. The delete handler uses an `access(ctx, in.ID, 0)` closure; this plan calls `s.channels.Access` directly.
- Adapt the names so they compile, and call `registerAttachmentActions(api, s, op)` from `Register`.
- If `Access`'s error for a missing permission is not an `httpx.Error`, keep the 404 mapping as written. It never reveals files in channels you can't read.

Update the messages `Attachments` interface to add:

```go
	Get(ctx context.Context, attachmentID id.ID) (*files.Attachment, error)
	SetKeep(ctx context.Context, a *files.Attachment, keep bool) error
	ExpireNow(ctx context.Context, a *files.Attachment) error
```

In `files/ttl_test.go`, replace the `env.Pool.Exec(... keep = true ...)` line with the API call shown in the test in Task 2.

- [ ] **Step 4: Run them and watch them pass, regenerate the types, and stage**

Run: `GOTOOLCHAIN=local go -C server test ./internal/messages ./internal/files`, then from clients/core run `pnpm run gen`.
Expected: PASS.

```bash
git add server/internal/messages server/internal/files clients/core/openapi.json clients/core/src/schema.d.ts
```

---

### Task 4: Expiry in the message UI

**Files:**
- Create: `clients/web/src/app/attachments/expiry.ts`
- Test: `clients/web/src/app/attachments/expiry.test.ts`
- Create: `clients/web/src/app/attachments/ExpiredFile.tsx`
- Modify: `clients/web/src/app/MessageList.tsx`:
  - in `Attachments` (:978), render expired files as placeholders, plus an expiry line;
  - add context-menu items (:886-906);
  - extend the `messageActions` input (:700).
- Modify: `clients/web/src/app/message-actions.ts` (+ test): add the actions `"keepFiles" | "unkeepFiles" | "removeFiles"`.
- Modify: `clients/web/src/app/MessageSheet.tsx` (render the three new actions)
- Modify: `clients/core/src/client.ts` (`keepAttachment(id, keep)` and `removeAttachment(id)`)

**Interfaces:**
- Consumes: `Attachment.expires_at?`, `keep` and `expired` (Task 2), and the endpoints (Task 3).
- Produces:
  - `expiresLabel(iso: string, now: number): string`, for example "Expires in 3 days", "Expires in 5 hours" or "Expires within the hour";
  - `fileFlags(atts): { expiring: boolean; kept: boolean; removable: boolean }`;
  - the `messageActions` input `can.files: boolean` (= `canDelete`), plus the attachments' state.

- [ ] **Step 1: Write the failing tests**

`expiry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiresLabel, fileFlags } from "./expiry";

const now = Date.parse("2026-10-14T12:00:00Z");
const att = (o: object) => ({ expired: false, keep: false, ...o });

describe("expiry", () => {
  it("says how long a file has left", () => {
    expect(expiresLabel("2026-10-17T12:00:00Z", now)).toBe("Expires in 3 days");
    expect(expiresLabel("2026-10-15T11:00:00Z", now)).toBe("Expires in 23 hours");
    expect(expiresLabel("2026-10-14T12:30:00Z", now)).toBe("Expires within the hour");
  });
  it("summarises a message's files", () => {
    expect(fileFlags([att({ expires_at: "x" }), att({})])).toEqual({ expiring: true, kept: false, removable: true });
    expect(fileFlags([att({ keep: true })])).toEqual({ expiring: false, kept: true, removable: true });
    expect(fileFlags([att({ expired: true })])).toEqual({ expiring: false, kept: false, removable: false });
  });
});
```

Add to `message-actions.test.ts`:

```ts
  it("offers file actions to whoever may manage them", () => {
    const files = [{ expires_at: "2026-10-20T00:00:00Z", keep: false, expired: false }];
    expect(messageActions({ content: "x", attachments: files }, { ...all, files: true })).toEqual(expect.arrayContaining(["keepFiles", "removeFiles"]));
    expect(messageActions({ content: "x", attachments: [{ keep: true, expired: false }] }, { ...all, files: true })).toContain("unkeepFiles");
    expect(messageActions({ content: "x", attachments: files }, { ...all, files: false })).not.toContain("removeFiles");
  });
```

Then update `all` in that test file to include `files: false`, so the existing expectations keep their exact order.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/app/attachments/expiry.test.ts src/app/message-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`expiry.ts`:

```ts
type FileState = { expires_at?: string | null; keep?: boolean; expired?: boolean };
const HOUR = 3_600_000;

export function expiresLabel(iso: string, now: number): string {
  const left = Date.parse(iso) - now;
  if (left < HOUR) return "Expires within the hour";
  const hours = Math.floor(left / HOUR);
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

/** What can be done to a message's files: keep the expiring ones, let kept ones expire, remove the live ones. */
export function fileFlags(atts: FileState[]) {
  const live = atts.filter((a) => !a.expired);
  return {
    expiring: live.some((a) => !!a.expires_at && !a.keep),
    kept: live.some((a) => !!a.keep),
    removable: live.length > 0,
  };
}
```

`message-actions.ts`:
- Extend `MessageAction` with `"keepFiles" | "unkeepFiles" | "removeFiles"`.
- The `m.attachments` type becomes `(FileState-like)[] | null`.
- Add `files: boolean` to `can`.
- After `album` and before `delete`:

```ts
  if (can.files) {
    const f = fileFlags(m.attachments ?? []);
    if (f.expiring) out.push("keepFiles");
    if (f.kept) out.push("unkeepFiles");
    if (f.removable) out.push("removeFiles");
  }
```

`ExpiredFile.tsx`:

```tsx
import type { Attachment } from "@datrope/core";
import { FileX } from "lucide-react";
import { formatBytes } from "@/session";

/** A file the size rules (or someone) deleted: its name stays in the message, the contents are gone. */
export function ExpiredFile({ attachment: a }: { attachment: Attachment }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-dashed bg-card px-3 py-2 text-muted-foreground">
      <FileX aria-hidden className="size-4" />
      <span className="line-through">{a.filename}</span>
      <span>{formatBytes(a.size)} · File expired</span>
    </span>
  );
}
```

`MessageList.tsx`, inside `Attachments`:
- First split `const expired = items.filter((a) => a.expired); const live = items.filter((a) => !a.expired);`. Build images and others from `live`, and render `expired.map((a) => <ExpiredFile key={a.id} attachment={a} />)` after them.
- After everything, if any live attachment has `expires_at` and not `keep`, render `<p className="text-xs text-muted-foreground">{expiresLabel(soonest, Date.now())}</p>`, where `soonest` is the minimum `expires_at`.
- Change the early return to `if (items.length === 0) return null;`, which is the same as before, so a message whose files have all expired still shows the placeholders.

`MessageList.tsx` row:
- Compute `const fileOps = canDelete && !m.pending && (m.attachments?.length ?? 0) > 0;`.
- Pass `files: fileOps` into `messageActions`.
- Add handlers:

```tsx
  const keepFiles = (keep: boolean) => void Promise.all((m.attachments ?? []).filter((a) => !a.expired && (keep ? a.expires_at && !a.keep : a.keep))
    .map((a) => client.keepAttachment(a.id, keep))).catch((e) => setError(errorText(e)));
  const removeFiles = () => void Promise.all((m.attachments ?? []).filter((a) => !a.expired).map((a) => client.removeAttachment(a.id)))
    .catch((e) => setError(errorText(e)));
```

- In the context menu, after the album submenu and only when `fileOps`, use `fileFlags(m.attachments ?? [])`:
  - `expiring` → `<ContextMenuItem onSelect={() => keepFiles(true)}><Infinity />Keep files forever</ContextMenuItem>`;
  - `kept` → `<ContextMenuItem onSelect={() => keepFiles(false)}><Timer />Let files expire</ContextMenuItem>`;
  - `removable` → `<ContextMenuItem variant="destructive" onSelect={() => setRemoving(true)}><FileX />Remove files</ContextMenuItem>`.
- Use a small `AlertDialog` for "Remove files", with the title "Remove the files?" and the body "The message stays, with the file names. This can't be undone." Its "Remove" button calls `removeFiles()`, in the same pattern as the existing delete confirm.

`MessageSheet.tsx`:
- Add props `onKeepFiles: (keep: boolean) => void` and `onRemoveFiles: () => void`.
- Add cases:
  - `"keepFiles"` → "Keep files forever";
  - `"unkeepFiles"` → "Let files expire";
  - `"removeFiles"` → "Remove files", destructive. Route it through the same confirm (call `onRemoveFiles`, which opens the dialog).
- Pass the props from `MessageList`.

`client.ts`:

```ts
  /** Keeps a sent file past the size rules, or lets them apply again. */
  async keepAttachment(id: string, keep: boolean) {
    await unwrap(this.api.PATCH("/api/attachments/{id}", { params: { path: { id } }, body: { keep } }));
  }

  /** Deletes a sent file's contents now; the message stays. */
  async removeAttachment(id: string) {
    await unwrap(this.api.DELETE("/api/attachments/{id}", { params: { path: { id } } }));
  }
```

The `MESSAGE_UPDATE` event refreshes the message in the store; the handler needs no local update.

- [ ] **Step 4: Run them and watch them pass, then run the gates and stage**

Run: `pnpm exec vitest run && pnpm exec tsc -p tsconfig.json && pnpm exec eslint src` (from clients/web), and `corepack pnpm -r typecheck`.
Expected: PASS, with no new lint errors.

```bash
git add clients/web/src/app/attachments/expiry.ts clients/web/src/app/attachments/expiry.test.ts clients/web/src/app/attachments/ExpiredFile.tsx clients/web/src/app/MessageList.tsx clients/web/src/app/message-actions.ts clients/web/src/app/message-actions.test.ts clients/web/src/app/MessageSheet.tsx clients/core/src/client.ts
```

---

## Final verification (after all tasks)

- `corepack pnpm -r typecheck`
- `corepack pnpm --filter @datrope/web test`
- `GOTOOLCHAIN=local go -C server test ./...`
- `corepack pnpm lint`
- Browser checks, once someone can sign in:
  - an admin adds the rule "over 1 MB → 1 day";
  - send a 2 MB file and see "Expires in 23 hours" under it;
  - choose "Keep files forever" and see the line disappear;
  - choose "Remove files" and see the "File expired" placeholder, with the download returning 410.

Report each result as it came out. Do not commit.
