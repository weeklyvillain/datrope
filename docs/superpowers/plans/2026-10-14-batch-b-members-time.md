# Batch B (members list and auto time) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The members list shows only people who can see the current channel (item 7).
- Each member's banner shows as a dimmed background behind their row, using the "A · Wash" treatment (item 6).
- Times written in messages ("gaming @ 9pm") are shown in the reader's own time zone, with a user setting for a 12-hour, 24-hour or automatic clock (item 8).

**Architecture:**
- **Members:** the list is filtered on the client with the existing `channelPerms` from `@datrope/core`.
- **Banner:** a CSS-only layer inside the row button.
- **Auto time:**
  - A nullable `messages.tz` column records the sender's IANA zone.
  - A pure parser and converter (`lib/time-mention.ts`) feeds a `remarkChat` token that renders a `TimeMention` chip.
  - A small `clock-pref` store drives both the chips and the existing message timestamps.

**Tech Stack:** React 18, Tailwind v4, zustand, react-markdown/remark, Vitest (node, no DOM), Go 1.25 + Postgres (goose migrations), huma, openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-10-14-multi-features-design.md`, sections B2, B3 and B4. Mockup: `docs/superpowers/mockups/MemberBanner.html`; concept **A · Wash** was chosen.

**Not in this plan:** B1 (rich composer) has its own plan, `2026-10-14-batch-b1-rich-composer.md`, because it is the riskiest change and the spec says it lands on its own.

## Global Constraints

- Never commit (AGENTS.md §5). Stage only.
- Never hardcode colors. Use token utilities. New colors become tokens in `clients/web/src/styles.css` first.
- The app is dark-only: no `dark:` variants.
- Keep accessible names stable. Playwright selects by role and label.
- Vitest runs in node, with no `document` or `window`. Put the logic in pure functions and test those.
- `rtk` is not on subagents' PATH, so they run commands plain. Use `GOTOOLCHAIN=local` for Go.
- Server tests need Docker running (pgtest starts Postgres).
- The next migration number is `00043`. Batch C will take `00044` and `00045`.
- **Banner (A · Wash):**
  - the banner fills the row at about 28 % opacity (`opacity-30`) and rises to about 42 % on hover (`opacity-40`);
  - it fades from transparent at 15 % to opaque at 85 %, left to right, so the avatar and name stay readable;
  - rows without a banner are unchanged.
- **Time detection:**
  - 12-hour times: `9pm`, `9 pm`, `9:30pm`, `9.30 pm`, `9 p.m.`, with `am` or `pm` in any case;
  - 24-hour times: `HH:MM` with a colon only, hours 0–23 and minutes 00–59;
  - an optional zone after the time (`CET`, `CEST`, `EET`, `EEST`, `WET`, `WEST`, `BST`, `EST`, `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST`, `PDT`, `UTC`, `GMT`, `UTC+2`, `GMT-5`, `UTC+5:30`) overrides the sender's zone;
  - never matched: bare numbers, code, links, or ratios such as `2:1`.

## Review Focus

1. **Prices and scores** ("12.50", "3:2 win", "10:30:15"). None of them may become a time chip. Covered by a test in Task 3.
2. **A sender and a reader in different zones across midnight or a DST change.** The chip shows the right day marker, and DST is applied for the date the message was sent. Covered by a test in Task 3.
3. **Old messages, webhook messages and pending messages, which have no `tz`.** A time without an explicit zone is not converted and renders as plain text. A time with an explicit zone still converts. Covered by a test in Task 4.
4. **A member who has not accepted the rules gate.** They see only the welcome channel, so they are listed only there. The server owner is never gated. Covered by a test in Task 1.
5. **An invalid `tz` from a client** (`"Mars/Base"`, 200 characters, an empty string). It is stored as null, and the send still succeeds. Covered by a test in Task 2.

---

### Task 1: The members list shows only people with access (B3)

**Files:**
- Create: `clients/web/src/app/member-access.ts`
- Test: `clients/web/src/app/member-access.test.ts`
- Modify: `clients/web/src/app/MemberList.tsx` (the `MemberList` props and the `useMemo` at ~:80)
- Modify: `clients/web/src/app/ChannelView.tsx:190,200` (pass `channelId`)

**Interfaces:**
- Produces: `canView(sv: { server: { id: string; owner_id: string; rules_gate?: boolean }; roles: Record<string, Role> }, m: Pick<Member, "user" | "role_ids" | "accepted_rules_at">, ch: Channel): boolean`.
- Produces: `MemberList({ sheet, channelId }: { sheet?: boolean; channelId?: string })`.

- [ ] **Step 1: Write the failing test**

`clients/web/src/app/member-access.test.ts`:

```ts
import { Perm, type Channel, type Member, type Role } from "@datrope/core";
import { describe, expect, it } from "vitest";
import { canView } from "./member-access";

const SID = "1";
const everyone: Role = { id: SID, name: "@everyone", permissions: Perm.ViewChannel | Perm.ReadHistory | Perm.SendMessages, position: 0 } as Role;
const mods: Role = { id: "2", name: "Mods", permissions: 0, position: 1 } as Role;
const sv = (rules_gate = false) => ({ server: { id: SID, owner_id: "99", rules_gate }, roles: { [SID]: everyone, "2": mods } });
const member = (id: string, role_ids: string[] = [], accepted = true): Member =>
  ({ user: { id, username: id }, role_ids, joined_at: "", accepted_rules_at: accepted ? "2026-01-01T00:00:00Z" : undefined }) as unknown as Member;
const chan = (overrides: Channel["overrides"] = [], type = "text"): Channel => ({ id: "10", type, name: "c", overrides } as unknown as Channel);

describe("canView", () => {
  it("lets everyone see an open channel", () => expect(canView(sv(), member("a"), chan())).toBe(true));
  it("hides a channel that @everyone is denied, except for the allowed role", () => {
    const ch = chan([
      { target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel },
      { target_type: "role", target_id: "2", allow: Perm.ViewChannel, deny: 0 },
    ]);
    expect(canView(sv(), member("a"), ch)).toBe(false);
    expect(canView(sv(), member("b", ["2"]), ch)).toBe(true);
  });
  it("applies member overrides last", () => {
    const ch = chan([
      { target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel },
      { target_type: "member", target_id: "c", allow: Perm.ViewChannel, deny: 0 },
    ]);
    expect(canView(sv(), member("c"), ch)).toBe(true);
  });
  it("always shows the owner", () =>
    expect(canView(sv(), member("99"), chan([{ target_type: "role", target_id: SID, allow: 0, deny: Perm.ViewChannel }]))).toBe(true));
  it("shows gated members only in the welcome channel", () => {
    expect(canView(sv(true), member("g", [], false), chan())).toBe(false);
    expect(canView(sv(true), member("g", [], false), chan([], "welcome"))).toBe(true);
    expect(canView(sv(true), member("99", [], false), chan())).toBe(true); // the owner is never gated
  });
});
```

If the `Channel` override type or the `Role` field names differ in `@datrope/core`, adjust only the fixtures, never the assertions. Check them with `grep -n "overrides" clients/core/src/types.ts clients/core/src/schema.d.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run, from clients/web: `pnpm exec vitest run src/app/member-access.test.ts`
Expected: FAIL, because `./member-access` is missing.

- [ ] **Step 3: Implement**

`clients/web/src/app/member-access.ts`:

```ts
import { Perm, channelPerms, hasPerm, type Channel, type Member, type Role } from "@datrope/core";

/** Whether member `m` can see channel `ch`: the same rule as the server's ViewChannel check, rules gate included. */
export function canView(
  sv: { server: { id: string; owner_id: string; rules_gate?: boolean }; roles: Record<string, Role> },
  m: Pick<Member, "user" | "role_ids" | "accepted_rules_at">,
  ch: Channel,
): boolean {
  const gated = !!sv.server.rules_gate && sv.server.owner_id !== m.user.id && !m.accepted_rules_at;
  return hasPerm(channelPerms(sv.server, Object.values(sv.roles), m.user.id, m.role_ids ?? [], ch, gated), Perm.ViewChannel);
}
```

Check that `channelPerms` and `hasPerm` are exported from `@datrope/core` (`clients/core/src/index.ts`). If they are not, import them from the path that other web files use (`rtk grep "channelPerms" clients/web/src`).

In `MemberList.tsx`:
- The signature becomes `export function MemberList({ sheet = false, channelId }: { sheet?: boolean; channelId?: string } = {})`.
- Add `const ch = useApp((s) => (channelId ? s.channels[channelId] : undefined));`.
- In the `useMemo`, replace `Object.values(sv?.members ?? {})` with `Object.values(sv?.members ?? {}).filter((m) => !sv || !ch || ch.type === "dm" || canView(sv, m, ch))`.
- Add `ch` to the dependency array.
- Update the doc comment's first line to "The members who can see this channel: …".
- `total` stays `members.length`, so the heading counts the people listed.

In `ChannelView.tsx`, pass `channelId={channelId}` to both `<MemberList />` usages.

- [ ] **Step 4: Run it and typecheck**

Run: `pnpm exec vitest run src/app/member-access.test.ts && pnpm exec tsc -p tsconfig.json`
Expected: PASS, with no type errors.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/app/member-access.ts clients/web/src/app/member-access.test.ts clients/web/src/app/MemberList.tsx clients/web/src/app/ChannelView.tsx
```

---

### Task 2: The server stores the sender's time zone (B4, server)

**Files:**
- Create: `server/internal/db/migrations/00043_message_tz.sql`
- Modify: `server/internal/messages/messages.go` (the `Message` struct, `messageCols` and `scanMessage`)
- Modify: `server/internal/messages/handlers.go` (`SendRequest` and the INSERT at ~:181)
- Modify: `server/internal/messages/posts.go` (the forum post create request and its INSERT at ~:77)
- Create: `server/internal/messages/tz.go`
- Modify: `server/cmd/datrope/main.go` (embed tzdata)
- Test: `server/internal/messages/tz_test.go`
- Regenerate: `clients/core/openapi.json` and `clients/core/src/schema.d.ts`

**Interfaces:**
- Produces: the JSON field `tz` (a string, omitted when empty) on `Message`, and the request field `tz` on send and on create-post.
- Produces (Go): `func cleanTZ(s string) *string`, which returns nil unless `time.LoadLocation` accepts the zone and its length is between 1 and 64.

- [ ] **Step 1: Write the failing test**

`server/internal/messages/tz_test.go`:

```go
package messages_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/messages"
)

func TestSendStoresSenderTimeZone(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"

	var m messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "gaming @ 9pm", "tz": "Europe/Stockholm"}, http.StatusCreated, &m)
	require.Equal(t, "Europe/Stockholm", m.TZ)

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, "Europe/Stockholm", page[0].TZ, "listed messages carry it too")

	// Edits keep the original zone.
	var edited messages.Message
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "gaming @ 10pm"}, http.StatusOK, &edited)
	require.Equal(t, "Europe/Stockholm", edited.TZ)
}

func TestSendDropsInvalidTimeZone(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"
	for _, tz := range []string{"Mars/Base", "", strings.Repeat("a", 64)} {
		var m messages.Message
		alice.Do(http.MethodPost, path, map[string]any{"content": "x", "tz": tz}, http.StatusCreated, &m)
		require.Empty(t, m.TZ, tz)
	}
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "tz": strings.Repeat("a", 65)}, http.StatusBadRequest, "VALIDATION_FAILED")
}
```

If the edit endpoint's method or path differs, find it in handlers.go (`EditRequest`) and use the real one.

- [ ] **Step 2: Run it and watch it fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/messages -run TimeZone`
Expected: FAIL to compile, because `m.TZ` is undefined.

- [ ] **Step 3: Implement**

`server/internal/db/migrations/00043_message_tz.sql`:

```sql
-- +goose Up
-- The sender's IANA time zone, so readers can see "9pm" in their own zone. Null for old, webhook and system messages.
ALTER TABLE messages ADD COLUMN tz text;

-- +goose Down
ALTER TABLE messages DROP COLUMN tz;
```

`server/internal/messages/tz.go`:

```go
package messages

import "time"

// cleanTZ keeps a client's IANA zone only if this server knows it; anything else is stored as no zone.
func cleanTZ(s string) *string {
	if s == "" || len(s) > 64 || s == "Local" {
		return nil
	}
	if _, err := time.LoadLocation(s); err != nil {
		return nil
	}
	return &s
}
```

`messages.go`:
- Add the field `TZ string \`json:"tz,omitempty" doc:"The sender's IANA time zone, for showing times they wrote in the reader's zone"\`` after `Kind`.
- Append `, tz` to `messageCols`, at the end of the string.
- In `scanMessage`, add `var tz *string`, append `&tz` to `dest` after `&mentionRoles` and before `extra...`, and set `if tz != nil { m.TZ = *tz }`.

`handlers.go`:
- Add `TZ string \`json:"tz,omitempty" maxLength:"64" doc:"The sender's IANA time zone"\`` to `SendRequest`.
- In the send handler, compute `tz := cleanTZ(in.Body.TZ)`. Extend the INSERT with a `tz` column and `$10`, passing `tz`.
- Set `m.TZ = in.Body.TZ` when `tz != nil`.

`posts.go`: do the same for the create-post request struct and its INSERT. Find the struct the handler decodes into.

`server/cmd/datrope/main.go`: add `_ "time/tzdata" // the runtime image (alpine) has no zoneinfo; LoadLocation needs it` to the imports.

Check every `INSERT ... RETURNING `+messageCols` and `SELECT `+messageCols+`, <extra>` call site. The edit at handlers.go:272 and inbox.go:46 must still scan, because `extra` comes after the new column. Search with `grep -rn messageCols server/internal`.

- [ ] **Step 4: Run it and watch it pass**

Run: `GOTOOLCHAIN=local go -C server test ./internal/messages`
Expected: PASS, the whole package. Docker must be running.

- [ ] **Step 5: Regenerate the client types**

Run, from clients/core: `pnpm run gen`
Expected: `openapi.json` and `src/schema.d.ts` gain `tz`. Then run `pnpm -r typecheck` from the repo root, which must pass.

- [ ] **Step 6: Stage**

```bash
git add server/internal/db/migrations/00043_message_tz.sql server/internal/messages server/cmd/datrope/main.go clients/core/openapi.json clients/core/src/schema.d.ts
```

---

### Task 3: Time parser, zone conversion and the clock preference (B4, pure logic)

**Files:**
- Create: `clients/web/src/lib/time-mention.ts`
- Test: `clients/web/src/lib/time-mention.test.ts`
- Create: `clients/web/src/lib/clock-pref.ts`
- Test: `clients/web/src/lib/clock-pref.test.ts`
- Modify: `clients/web/src/lib/message-time.ts` (`twelve` uses the preference)

**Interfaces:**
- Produces (`time-mention.ts`):
  - `interface TimeMatch { index: number; length: number; hour: number; minute: number; zone?: string }`, where `hour` is 0–23 and `zone` is the raw text, e.g. "CET" or "UTC+2".
  - `findTimes(text: string): TimeMatch[]`
  - `zoneOffsetMinutes(zone: string, atUtcMs: number): number | null`. It handles IANA names, abbreviations and `UTC±H[:MM]`, and returns null when the zone is unknown.
  - `resolveTime(t: TimeMatch, sentAtIso: string, senderTz?: string): Date | null`. That is the instant meant, on the sender's calendar date. It returns null when there is no zone at all.
  - `dayShift(atIso: string, sourceZone: string, readerZone: string): number`. It is the reader's calendar date minus the source zone's date at that instant: -1, 0 or +1.
- Produces (`clock-pref.ts`):
  - `type ClockPref = "auto" | "12" | "24"`
  - `getClockPref(): ClockPref`
  - `setClockPref(p: ClockPref): void`
  - `useClockPref(): ClockPref`
  - `clockStore` (a zustand vanilla store)
- Changes (`message-time.ts`): `clockTime(d, locale?, pref = getClockPref())`. `headStamp` and the new `chipTime` follow the same preference.

- [ ] **Step 1: Write the failing tests**

`clients/web/src/lib/time-mention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dayShift, findTimes, resolveTime, zoneOffsetMinutes } from "./time-mention";

const hm = (s: string) => findTimes(s).map((t) => [s.slice(t.index, t.index + t.length), t.hour, t.minute, t.zone]);

describe("findTimes", () => {
  it("finds 12-hour times", () => {
    expect(hm("gaming @ 9pm")).toEqual([["9pm", 21, 0, undefined]]);
    expect(hm("at 9 PM?")).toEqual([["9 PM", 21, 0, undefined]]);
    expect(hm("9:30pm or 9.30 am")).toEqual([["9:30pm", 21, 30, undefined], ["9.30 am", 9, 30, undefined]]);
    expect(hm("12am and 12pm")).toEqual([["12am", 0, 0, undefined], ["12pm", 12, 0, undefined]]);
    expect(hm("7 p.m.")).toEqual([["7 p.m.", 19, 0, undefined]]);
  });
  it("finds 24-hour times with a colon", () => {
    expect(hm("kl 21:00")).toEqual([["21:00", 21, 0, undefined]]);
    expect(hm("from 9:05 to 23:59")).toEqual([["9:05", 9, 5, undefined], ["23:59", 23, 59, undefined]]);
  });
  it("reads a zone written after the time", () => {
    expect(hm("9pm CET")).toEqual([["9pm CET", 21, 0, "CET"]]);
    expect(hm("21:00 UTC+2")).toEqual([["21:00 UTC+2", 21, 0, "UTC+2"]]);
    expect(hm("10:30 GMT-5:30")).toEqual([["10:30 GMT-5:30", 10, 30, "GMT-5:30"]]);
  });
  it("ignores things that are not times", () => {
    for (const s of ["at 9", "costs 12.50", "won 3:2", "10:30:15", "24:00", "9:60", "13pm", "0pm", "v1.2.3", "a9pm", "ratio 16:9"])
      expect(findTimes(s), s).toEqual([]);
  });
});

describe("zoneOffsetMinutes", () => {
  const winter = Date.UTC(2026, 0, 15, 12);
  const summer = Date.UTC(2026, 6, 15, 12);
  it("knows IANA zones with DST", () => {
    expect(zoneOffsetMinutes("Europe/Stockholm", winter)).toBe(60);
    expect(zoneOffsetMinutes("Europe/Stockholm", summer)).toBe(120);
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
  });
  it("knows abbreviations and fixed offsets", () => {
    expect(zoneOffsetMinutes("CET", summer)).toBe(60); // an abbreviation is fixed, whatever the season
    expect(zoneOffsetMinutes("PDT", winter)).toBe(-420);
    expect(zoneOffsetMinutes("UTC+5:30", winter)).toBe(330);
    expect(zoneOffsetMinutes("GMT", winter)).toBe(0);
  });
  it("returns null for unknown zones", () => expect(zoneOffsetMinutes("Mars/Base", winter)).toBeNull());
});

describe("resolveTime", () => {
  const t = (s: string) => findTimes(s)[0]!;
  it("uses the sender's zone and their calendar date", () => {
    // Sent 2026-03-10 18:00 UTC = 19:00 in Stockholm; "9pm" is 21:00 Stockholm = 20:00 UTC that day.
    expect(resolveTime(t("9pm"), "2026-03-10T18:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-03-10T20:00:00.000Z");
  });
  it("uses the sender's date even when UTC is already the next day", () => {
    // 23:30 in Los Angeles on 10 March is 06:30 UTC on 11 March; "9pm" is 9pm on the 10th in LA (PDT, -7).
    expect(resolveTime(t("9pm"), "2026-03-11T06:30:00Z", "America/Los_Angeles")?.toISOString()).toBe("2026-03-11T04:00:00.000Z");
  });
  it("applies DST for that date", () => {
    expect(resolveTime(t("12:00"), "2026-07-01T08:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(resolveTime(t("12:00"), "2026-01-01T08:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });
  it("prefers a written zone over the sender's", () =>
    expect(resolveTime(t("9pm EST"), "2026-03-10T18:00:00Z", "Europe/Stockholm")?.toISOString()).toBe("2026-03-11T02:00:00.000Z"));
  it("gives up without any zone", () => expect(resolveTime(t("9pm"), "2026-03-10T18:00:00Z", undefined)).toBeNull());
});

describe("dayShift", () => {
  it("is 0 when both see the same date", () => expect(dayShift("2026-03-10T20:00:00Z", "Europe/Stockholm", "America/Los_Angeles")).toBe(0)); // 21:00 vs 13:00
  it("is +1 when it is already tomorrow for the reader", () => expect(dayShift("2026-03-11T04:00:00Z", "America/Los_Angeles", "Europe/Stockholm")).toBe(1)); // 21:00 LA = 05:00 Stockholm
  it("is -1 when it is still yesterday for the reader", () => expect(dayShift("2026-03-11T00:00:00Z", "Europe/Stockholm", "America/Los_Angeles")).toBe(-1)); // 01:00 vs 17:00
  it("works with abbreviations and offsets", () => expect(dayShift("2026-03-11T04:00:00Z", "PDT", "UTC+1")).toBe(1));
});
```

`clients/web/src/lib/clock-pref.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getClockPref, setClockPref } from "./clock-pref";
import { clockTime } from "./message-time";

describe("clock preference", () => {
  const d = new Date(Date.UTC(2026, 0, 1, 21, 5));
  it("defaults to auto, which follows the locale", () => {
    expect(getClockPref()).toBe("auto");
    expect(clockTime(d, "en-US", "auto")).toMatch(/PM/);
    expect(clockTime(d, "sv-SE", "auto")).not.toMatch(/PM/);
  });
  it("forces a 12- or 24-hour clock", () => {
    expect(clockTime(d, "sv-SE", "12")).toMatch(/PM|em/i);
    expect(clockTime(d, "en-US", "24")).not.toMatch(/PM/);
  });
  it("remembers the choice for this session even without storage", () => {
    setClockPref("24");
    expect(getClockPref()).toBe("24");
    setClockPref("auto");
  });
});
```

`clockTime` formats in the process time zone, and the tests only check the AM/PM shape, so they hold in any TZ.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/lib/time-mention.test.ts src/lib/clock-pref.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement `clock-pref.ts`**

```ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** 12- or 24-hour clock for times in messages; auto follows the locale. Kept on this device. */
export type ClockPref = "auto" | "12" | "24";

const KEY = "datrope.clock";
const storage = (): Storage | undefined => {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
};
const read = (): ClockPref => {
  try {
    const v = storage()?.getItem(KEY);
    return v === "12" || v === "24" ? v : "auto";
  } catch {
    return "auto";
  }
};

export const clockStore = createStore<{ pref: ClockPref }>(() => ({ pref: read() }));
export const getClockPref = () => clockStore.getState().pref;
export function setClockPref(pref: ClockPref) {
  clockStore.setState({ pref });
  try { storage()?.setItem(KEY, pref); } catch { /* private mode: this session only */ }
}
export const useClockPref = () => useStore(clockStore, (s) => s.pref);
```

- [ ] **Step 4: Make `message-time.ts` follow the preference**

```ts
import { getClockPref, type ClockPref } from "./clock-pref";
// ...
/** The clock is 12-hour: by choice, or (auto) because the locale uses one. */
const twelve = (locale?: string, pref: ClockPref = getClockPref()) =>
  pref === "12" || (pref === "auto" && /h1[12]/.test(fmt(locale, "hour", { hour: "numeric" }).resolvedOptions().hourCycle ?? ""));
/** "08:33" or "8:33 AM", by the clock preference. */
export const clockTime = (d: Date, locale?: string, pref: ClockPref = getClockPref()) =>
  (twelve(locale, pref) ? fmt(locale, "clock12", { hour: "numeric", minute: "2-digit", hourCycle: "h12" }) : fmt(locale, "clock24", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(d);
```

`hourCycle: "h12"` is needed so that a forced 12-hour clock also works in a 24-hour locale. `headStamp` already calls `clockTime(d, locale)`, so it follows the preference with no change.

- [ ] **Step 5: Implement `time-mention.ts`**

```ts
/** A time someone wrote in a message ("9pm", "21:00 CET"), found in plain text. */
export interface TimeMatch {
  index: number;
  length: number;
  hour: number; // 0-23
  minute: number;
  zone?: string; // as written: "CET", "UTC+2", ...
}

const ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};
const ZONE = String.raw`(?:(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?|${Object.keys(ABBR).join("|")})`;
// 12-hour: 1-12 with optional :mm or .mm, then am/pm. 24-hour: H:MM or HH:MM with a colon.
// Not inside a word or a longer number ("v1.2.3", "10:30:15", "a9pm").
const TIME = new RegExp(
  String.raw`(?<![\w:.])(?:(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?([ap])\.?m\.?|([01]?\d|2[0-3]):([0-5]\d))(?![\w:]|\.\d)(?:\s(${ZONE})(?![\w+-]))?`,
  "gi",
);

export function findTimes(text: string): TimeMatch[] {
  const out: TimeMatch[] = [];
  for (const m of text.matchAll(TIME)) {
    const zone = m[6] ? m[6].toUpperCase() : undefined;
    if (m[3]) {
      const h = Number(m[1]) % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
      out.push({ index: m.index, length: m[0].length, hour: h, minute: Number(m[2] ?? 0), zone });
    } else {
      out.push({ index: m.index, length: m[0].length, hour: Number(m[4]), minute: Number(m[5]), zone });
    }
  }
  return out;
}

const parts = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string): Intl.DateTimeFormat | null {
  let f = parts.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    } catch {
      return null;
    }
    parts.set(tz, f);
  }
  return f;
}

/** The calendar date and wall time in `tz` at `utcMs`. */
function wall(tz: string, utcMs: number) {
  const f = partsIn(tz);
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(utcMs).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

/** Minutes east of UTC for `zone` at `atUtcMs`: an IANA name (with DST), an abbreviation or UTC±H[:MM]. */
export function zoneOffsetMinutes(zone: string, atUtcMs: number): number | null {
  const up = zone.toUpperCase();
  if (up in ABBR) return ABBR[up]!;
  const fixed = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(up);
  if (fixed) return (fixed[1] === "-" ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0));
  const w = wall(zone, atUtcMs);
  if (!w) return null;
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(atUtcMs / 60000) * 60000) / 60000);
}

/** The instant a written time means: that wall time on the sender's calendar date, in the written zone or the sender's. */
export function resolveTime(t: TimeMatch, sentAtIso: string, senderTz?: string): Date | null {
  const zone = t.zone ?? senderTz;
  if (!zone) return null;
  const sent = Date.parse(sentAtIso);
  const day = wall(senderTz ?? "UTC", sent) ?? wall("UTC", sent)!;
  const guess = Date.UTC(day.y, day.mo - 1, day.d, t.hour, t.minute);
  const first = zoneOffsetMinutes(zone, guess);
  if (first === null) return null;
  // Twice, so a DST change between the guess and the answer settles on the right offset.
  const second = zoneOffsetMinutes(zone, guess - first * 60000) ?? first;
  return new Date(guess - second * 60000);
}

/** The calendar day number (days since 1970) in `zone` at `ms`; null for an unknown zone. */
function dayIn(zone: string, ms: number): number | null {
  const off = zoneOffsetMinutes(zone, ms);
  return off === null ? null : Math.floor((ms + off * 60000) / 86400000);
}

/** How many days the reader's date is ahead of the source zone's date at `atIso`: -1, 0 or +1 (for a "+1d" marker). */
export function dayShift(atIso: string, sourceZone: string, readerZone: string): number {
  const ms = Date.parse(atIso);
  const a = dayIn(readerZone, ms);
  const b = dayIn(sourceZone, ms);
  return a === null || b === null ? 0 : a - b;
}
```

- [ ] **Step 6: Run them and watch them pass**

Run: `pnpm exec vitest run src/lib/time-mention.test.ts src/lib/clock-pref.test.ts src/lib`
Expected: PASS. That includes any existing `message-time` tests; if one assumed locale-only behaviour, pass `"auto"` there.

If one of the regex negative cases fails, fix the regex. Do not drop the case. If a case cannot be met without breaking a positive one, report DONE_WITH_CONCERNS and quote both.

- [ ] **Step 7: Stage**

```bash
git add clients/web/src/lib/time-mention.ts clients/web/src/lib/time-mention.test.ts clients/web/src/lib/clock-pref.ts clients/web/src/lib/clock-pref.test.ts clients/web/src/lib/message-time.ts
```

---

### Task 4: Time chips in messages, the clock setting, and sending `tz` (B4, UI)

**Files:**
- Modify: `clients/web/src/chat/remarkChat.ts` (a `time` option and a time split on text nodes)
- Test: `clients/web/src/chat/remarkChat.test.ts` (create it, or extend it if it exists)
- Create: `clients/web/src/chat/TimeMention.tsx`
- Modify: `clients/web/src/chat/Markdown.tsx` (the `time` prop and the span renderer)
- Modify: `clients/web/src/app/MessageList.tsx:844` (pass `time`) and the row (subscribe to the clock preference)
- Modify: `clients/core/src/client.ts:626` (`send` sends `tz`) and `clients/core/src/store.ts:532` (pending messages get `tz`)
- Modify: `clients/web/src/app/settings/AppearanceSettings.tsx` (the Clock radio group)

**Interfaces:**
- Consumes:
  - from Task 3: `findTimes`, `resolveTime`, `useClockPref`, `clockTime`;
  - from Task 2: `Message.tz` (`tz?: string`).
- Produces:
  - `ChatOptions.time?: { sentAt: string; tz?: string }`
  - the remark node `chatTime`, which becomes `<span class="time-mention" data-time="<ISO>" data-src="<as written>" data-zone="<zone used>">`
  - `Markdown`'s new prop `time?: { sentAt: string; tz?: string }`

- [ ] **Step 1: Write the failing test**

`clients/web/src/chat/remarkChat.test.ts`. If the file exists, add a `describe`. Build the tree by hand, so the test needs no react-markdown:

```ts
import { describe, expect, it } from "vitest";
import { remarkChat, type ChatOptions } from "./remarkChat";

const base: ChatOptions = { custom: new Map(), shortcodes: null, users: new Map() };
type N = { type: string; value?: string; children?: N[]; data?: { hProperties?: Record<string, unknown> } };
const run = (text: string, o: ChatOptions) => {
  const tree: N = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
  remarkChat(o)(tree as never);
  return tree.children![0]!.children!;
};

describe("time mentions", () => {
  const time = { sentAt: "2026-03-10T18:00:00Z", tz: "Europe/Stockholm" };
  it("wraps a written time with the instant it means", () => {
    const nodes = run("gaming @ 9pm!", { ...base, time });
    expect(nodes.map((n) => n.type)).toEqual(["text", "chatTime", "text"]);
    expect(nodes[1]!.data!.hProperties).toMatchObject({ className: ["time-mention"], "data-time": "2026-03-10T20:00:00.000Z", "data-src": "9pm", "data-zone": "Europe/Stockholm" });
    expect(nodes[1]!.children![0]!.value).toBe("9pm");
  });
  it("leaves times alone without message time info (topics, previews)", () =>
    expect(run("gaming @ 9pm", base).map((n) => n.type)).toEqual(["text"]));
  it("does not convert a zoneless time in a message without a tz", () =>
    expect(run("at 9pm", { ...base, time: { sentAt: time.sentAt } }).map((n) => n.type)).toEqual(["text"]));
  it("still converts a time with a written zone in a message without a tz", () =>
    expect(run("at 9pm UTC", { ...base, time: { sentAt: time.sentAt } }).map((n) => n.type)).toEqual(["text", "chatTime"]));
  it("works next to mentions and emoji", () => {
    const nodes = run("@bob 21:00 :x:", { ...base, users: new Map([["bob", { id: "1", name: "Bob" }]]), time });
    expect(nodes.map((n) => n.type)).toEqual(["chatMention", "text", "chatTime", "text"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/chat/remarkChat.test.ts`
Expected: FAIL. There are no `chatTime` nodes yet.

- [ ] **Step 3: Implement the remark step**

In `remarkChat.ts`:
- Import `findTimes` and `resolveTime` from `@/lib/time-mention`.
- Add `time?: { sentAt: string; tz?: string }; // the message's send time and sender zone: written times become chips` to `ChatOptions`.
- Add:

```ts
/** Wraps written times ("9pm", "21:00 CET") in plain text nodes; other nodes are left alone. */
function times(nodes: Node[], t: ChatOptions["time"]): Node[] {
  if (!t) return nodes;
  return nodes.flatMap((n) => {
    if (n.type !== "text" || !n.value) return [n];
    const out: Node[] = [];
    let last = 0;
    for (const m of findTimes(n.value)) {
      const at = resolveTime(m, t.sentAt, t.tz);
      if (!at) continue;
      const src = n.value.slice(m.index, m.index + m.length);
      if (m.index > last) out.push(text(n.value.slice(last, m.index)));
      out.push({ type: "chatTime", data: { hName: "span", hProperties: { className: ["time-mention"], "data-time": at.toISOString(), "data-src": src, "data-zone": m.zone ?? t.tz } }, children: [text(src)] });
      last = m.index + m.length;
    }
    if (last === 0) return [n];
    if (last < n.value.length) out.push(text(n.value.slice(last)));
    return out;
  });
}
```

- In `walk`, change the text branch to `next.push(...highlight(times(splitText(child.value, o) ?? [child], o.time), o.highlight));`.
- Update the file's top comment to mention written times.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm exec vitest run src/chat`
Expected: PASS.

- [ ] **Step 5: Render the chip**

`clients/web/src/chat/TimeMention.tsx`:

```tsx
import { Clock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClockPref } from "@/lib/clock-pref";
import { clockTime } from "@/lib/message-time";
import { dayShift } from "@/lib/time-mention";

/** A time someone wrote, shown in my zone and clock; the tooltip shows what they wrote and in which zone. */
export function TimeMention({ iso, src, zone }: { iso: string; src: string; zone?: string }) {
  const pref = useClockPref();
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === mine) return <span className="time-mention">{src}</span>; // my own zone: nothing to convert
  const shift = dayShift(iso, zone, mine);
  const label = `${clockTime(new Date(iso), undefined, pref)}${shift > 0 ? " +1d" : shift < 0 ? " −1d" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} tabIndex={0} aria-label={`${label} your time (${src} ${zone})`}
          className="time-mention inline-flex items-baseline gap-0.5 rounded bg-accent px-1 font-medium text-foreground">
          <Clock aria-hidden className="size-3 self-center text-muted-foreground" />
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{src} in {zone}</TooltipContent>
    </Tooltip>
  );
}
```

`Tooltip` needs a ref-forwarding child, and a plain `<time>` element is fine. Check that a `TooltipProvider` wraps the app (`grep -rn TooltipProvider clients/web/src`). If one does not, wrap the `Tooltip` locally.

In `Markdown.tsx`:
- Add `time-mention` to the span renderer, before the generic fallback:

```tsx
    if (className === "time-mention") {
      const q = p as Record<string, unknown>;
      return <TimeMention iso={String(q["data-time"])} src={String(q["data-src"])} zone={q["data-zone"] as string | undefined} />;
    }
```

- Add the prop `time?: { sentAt: string; tz?: string }` to `Markdown`. Pass it into `options` as `time`, and add `time?.sentAt` and `time?.tz` to the `useMemo` dependencies.
- The inline renderer keeps its generic span, so topics show the raw text.

In `MessageList.tsx:844`, add `time={m.pending ? undefined : { sentAt: m.created_at, tz: m.tz ?? undefined }}` to `<Markdown … />`. In the row component that renders times (the one around :774/:798), add `useClockPref();` so the stamps re-render when the setting changes. Import it from `@/lib/clock-pref`.

- [ ] **Step 6: Send `tz` with new messages**

In `clients/core/src/client.ts` `send()`, add this to the body:

```ts
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
```

Do the same in the forum-post create call. Find it with `grep -n "posts" clients/core/src/client.ts`. In `addPending`, add `tz: Intl.DateTimeFormat().resolvedOptions().timeZone` to the pending message only if the `ClientMessage` type allows it. Pending messages are not converted anyway (`time` is undefined while pending), so skip it if the types fight.

- [ ] **Step 7: Add the Clock setting**

In `AppearanceSettings.tsx`, add this under the theme picker. Import `setClockPref`, `useClockPref` and `ClockPref` from `@/lib/clock-pref`.

```tsx
      <div className="grid gap-2 pt-4">
        <p className="text-sm font-medium">Clock</p>
        <p className="text-sm text-muted-foreground">How times show in messages, including times people write ("9pm") converted to your time zone.</p>
        <RadioGroup aria-label="Clock" value={clock} onValueChange={(v) => setClockPref(v as ClockPref)} className="flex gap-4">
          {([["auto", "Automatic"], ["12", "12-hour"], ["24", "24-hour"]] as const).map(([v, label]) => (
            <Label key={v} htmlFor={`clock-${v}`} className="flex items-center gap-2 font-normal">
              <RadioGroupItem id={`clock-${v}`} value={v} /> {label}
            </Label>
          ))}
        </RadioGroup>
      </div>
```

Add `const clock = useClockPref();` at the top of the component, and wrap the existing content and the new block in a fragment or grid as the layout needs.

- [ ] **Step 8: Typecheck and run the tests**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run` (from clients/web), and `pnpm -r typecheck` from the root.
Expected: PASS.

- [ ] **Step 9: Stage**

```bash
git add clients/web/src/chat clients/web/src/lib/time-mention.ts clients/web/src/lib/time-mention.test.ts clients/web/src/app/MessageList.tsx clients/web/src/app/settings/AppearanceSettings.tsx clients/core/src/client.ts clients/core/src/store.ts
```

---

### Task 5: Banner wash behind member rows (B2)

**Files:**
- Modify: `clients/web/src/app/MemberList.tsx` (`MemberRow`)
- Create: `clients/web/src/app/MemberBanner.tsx`
- Test: `clients/web/src/app/MemberBanner.test.tsx`

**Interfaces:**
- Produces: `MemberBanner({ url, dim }: { url?: string; dim?: boolean })`. It renders nothing without `url`.

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/session", () => ({ client: { url: (p: string) => `https://x${p}` } }));
const { MemberBanner } = await import("./MemberBanner");

describe("MemberBanner", () => {
  it("renders nothing without a banner", () => expect(renderToStaticMarkup(<MemberBanner />)).toBe(""));
  it("renders a decorative, lazy, sized image behind the row", () => {
    const html = renderToStaticMarkup(<MemberBanner url="/api/banners/1" />);
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("w=256");
    expect(html).toContain("opacity-30");
  });
  it("dims further for offline members", () => expect(renderToStaticMarkup(<MemberBanner url="/api/banners/1" dim />)).toContain("opacity-15"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/app/MemberBanner.test.tsx`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

`clients/web/src/app/MemberBanner.tsx`:

```tsx
import { sizedImage } from "@/lib/sized-image";
import { cn } from "@/lib/utils";

/**
 * A member's profile banner as a dimmed wash behind their row (mockup MemberBanner.html, concept A): it fades in from
 * the left so the avatar and name stay readable. The row button must be `relative isolate overflow-hidden group`.
 */
export function MemberBanner({ url, dim = false }: { url?: string; dim?: boolean }) {
  if (!url) return null;
  const img = sizedImage(url, 240);
  return (
    <img {...img} alt="" aria-hidden loading="lazy" decoding="async" draggable={false}
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 size-full object-cover transition-opacity duration-150",
        "[mask-image:linear-gradient(to_right,transparent_15%,black_85%)]",
        dim ? "opacity-15 group-hover:opacity-25" : "opacity-30 group-hover:opacity-40",
      )} />
  );
}
```

In `MemberRow`:
- Add `group relative isolate overflow-hidden` to the `RefButton`'s `className` inside `cn(...)`.
- Render `<MemberBanner url={m.user.banner_url} dim={status === "offline"} />` as the button's first child.

Because of the `isolate`, the `-z-10` image paints above the button's own hover background (`bg-accent`) and below its text, so hover still shows. Check that `m.user.banner_url` exists on the member's user type with `grep -n "banner_url" clients/core/src/schema.d.ts`. `PublicUser` has it.

- [ ] **Step 4: Run it and typecheck**

Run: `pnpm exec vitest run src/app/MemberBanner.test.tsx && pnpm exec tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add clients/web/src/app/MemberBanner.tsx clients/web/src/app/MemberBanner.test.tsx clients/web/src/app/MemberList.tsx
```

---

## Final verification (after all tasks)

- `pnpm -r typecheck`
- `pnpm --filter @datrope/web test`
- `GOTOOLCHAIN=local go -C server test ./internal/messages`
- `pnpm lint`
- Browser checks, once someone can sign in to the dev server:
  - a channel with restricted access lists only the people who can see it;
  - members with banners show the wash, and it brightens on hover;
  - "gaming @ 9pm" from a user in another zone shows a chip with the converted time;
  - switching Clock to 24-hour changes both the stamps and the chips.

Report each result as it came out. Do not commit.
