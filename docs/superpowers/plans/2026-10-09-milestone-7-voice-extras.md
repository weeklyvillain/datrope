# Milestone 7: Voice extras — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voice calls nicer:
- **Voice channel view:** the stage and grid layouts from the mockups ("Stop watching", screen-share audio volume, full screen, an invite tile).
- **Local controls:** per-person volume (0–200 %), "mute for me" and "hide video", stored on this device, with a badge on tiles you changed.
- **A soundboard:** uploaded short clips, each with an emoji, played to everyone in the call.

**Architecture:**
- **Server, sounds:** the `expressions` package (M5) gains sounds. Upload validates the file type and measures the duration from the file itself (WAV, Ogg Vorbis/Opus or MP3), and stores the bytes in the `files` blob store.
- **Server, playing:** the `voice` package gains `POST /api/voice/soundboard`. It checks that the caller is in a call and may use the soundboard, rate-limits, and sends `SOUNDBOARD_PLAY` only to the people in that call. No audio goes through LiveKit for this.
- **Client, playback:** every client decodes and caches the clip and plays it itself at its own soundboard volume.
- **Client, local settings:** volume, mute-for-me and hide-video are per-device preferences applied to the LiveKit room through `RemoteParticipant.setVolume` (with `webAudioMix`, so gain can exceed 100 %) and by unsubscribing hidden cameras.

**Tech Stack:** Go (Huma, pgx, goose) · `@datrope/core` · React 18 + shadcn/ui · `livekit-client` 2.22.3 · Web Audio API · Vitest · Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-one-server-design.md`:
- §2: soundboard, per-user volume;
- §3: Sound in `expressions`;
- §4: `USE_SOUNDBOARD`, `MANAGE_EXPRESSIONS`;
- §5: events `SOUND_UPDATE`, `SOUNDBOARD_PLAY`;
- §6: M7;
- §7: deleted sound; soundboard rate limit 1 per 2 s per user;
- §8: M7 e2e, playing a sound shows the chip in a second browser.

**Mockups:**
- `docs/superpowers/mockups/VoiceStage.dc.html`:
  - header buttons "Grid layout", "Channel chat", "Soundboard";
  - the stage with the watched screen share large ("Stop watching", "Full screen", "Volume of Bob's screen audio");
  - the people strip;
  - the per-person volume popover ("Carol's volume", "Volume for Carol, just for you", 0–200);
  - call controls.
- `docs/superpowers/mockups/VoiceSoundboard.dc.html`:
  - grid layout with an invite tile ("Invite someone to Lounge", "Copy invite link");
  - the "played <sound>" chip on a tile;
  - the soundboard panel: "Search sounds", "Favourite" stars, "Play <name>, <duration> s" buttons, "Add sound", and "Soundboard volume, just for you" (0–100), with the hint "Everyone in Lounge hears a sound you play. Hold Shift to preview it only for yourself."

## Global Constraints

- **Never commit.** (AGENTS.md §5.) Each task ends with a *Checkpoint*; the controller reviews and stages; nobody commits.
- **The user's unrelated work in progress is in the working tree. Never modify, stage, delete or "fix" these:**
  - `clients/web/src/sounds.ts`;
  - `clients/web/src/assets/sounds/*.mp3`;
  - the unstaged edits in `clients/web/src/main.tsx` and `clients/web/src/voice/voice.ts`: built-in join and leave sounds.
  - If a task must change `voice/voice.ts`, keep the changes few and confined to their own lines, never edit the user's `play("join")` / `play("leave")` lines, and list every hunk in the report. The controller stages only your hunks.
- **Sounds:**
  - OGG (Vorbis or Opus), MP3 or WAV;
  - at most **5 s** and **512 KB**;
  - one Unicode emoji each, validated with the M5 `validUnicodeEmoji` rules;
  - name 1–32 characters;
  - at most **100 sounds** per server;
  - upload, rename and delete need `MANAGE_EXPRESSIONS`;
  - duration is measured by the server from the file.
- **Playing:**
  - needs `USE_SOUNDBOARD` and `SPEAK` in the call's channel, and not being server-muted;
  - rate limit **1 per 2 s per user** (`429 RATE_LIMITED`);
  - `SOUNDBOARD_PLAY` = `{channel_id, user_id, sound_id}` goes only to the call's participants;
  - every client plays it locally at its own soundboard volume (default 60 %), except when deafened or when it has "muted for me" the player;
  - Shift-click previews locally without sending anything.
- **Local settings** (per device, never sent):
  - per-person volume 0–200 % (default 100);
  - mute for me;
  - hide video (the camera is unsubscribed while hidden);
  - per-sharer screen audio volume 0–200 %;
  - soundboard volume 0–100 %;
  - soundboard favourites.
  - A tile shows a small badge when its person's volume isn't 100 % or they are muted for you.
- **Web UI:** shadcn/ui first (AGENTS.md §6); tokens only; dark only; accessible names exactly as in the mockups. The e2e uses role + name.
- **Dev environment:**
  - the user's dev servers run on :8081/:5173; implementers never start or stop them;
  - no `pnpm install`/`add`;
  - Go tests run from PowerShell with `$env:GOTOOLCHAIN='local'`;
  - a local e2e run needs the LiveKit port override in the session scratchpad (`compose.local-ports.yml`), because the dev LiveKit holds 7881.

## Decisions this plan makes

1. **Sound limits:** 100 sounds per server; names are not unique; files are served publicly at `/api/sounds/{id}` (like emoji) so `<audio>`/`fetch` work without a session. READY has `sounds` for members.
2. **Server-muted members** can't play sounds (`403 SERVER_MUTED`); the soundboard button is disabled with a tooltip.
3. **Clip loading:** clients fetch and decode each clip once, on first play or on opening the soundboard, through one shared `AudioContext`. Clips play through a gain node at the soundboard volume.
4. **The "played" chip** stays on the player's tile for 3 s ("🎺 Airhorn"). If the tile isn't visible (stage layout, person not in the strip), nothing is shown.
5. **Layout:** grid by default; stage when someone's screen share is being watched (you can switch back to grid with "Grid layout"). In the stage, the first watched share is large, everyone else is in a strip.
6. **The invite tile** appears in the grid when you are alone or with at most 3 others. "Copy invite link" creates or reuses an unlimited invite with `CREATE_INVITE` and copies `<origin>/invite/<code>`. Without that permission the tile isn't shown.

## File Structure

```
server/internal/db/migrations/00018_sounds.sql
server/internal/expressions/  sounds.go (routes, list), audio.go (type + duration), audio_test.go, sounds_test.go
server/internal/voice/        soundboard.go (+ test)
server/internal/app/          wiring, READY sounds, schemas
clients/core/src/             sounds state/events, client API
clients/web/src/voice/        prefs.ts (+test: local settings), mixer.ts (applies prefs to the room), soundboard-audio.ts (clip cache + playback)
clients/web/src/app/voice/    VoiceChannelView (layouts), StageView.tsx, GridView.tsx, Tile.tsx (badge, chip, volume popover), InviteTile.tsx, SoundboardPanel.tsx
clients/web/src/app/server-settings/Soundboard.tsx
clients/web/e2e/chat.spec.ts
```

---

### Task 1: Sounds (server)

**Files:**
- Create: `server/internal/db/migrations/00018_sounds.sql`, `server/internal/expressions/audio.go`, `server/internal/expressions/audio_test.go`, `server/internal/expressions/sounds.go`, `server/internal/expressions/sounds_test.go`
- Modify: `server/internal/expressions/expressions.go` (shared helpers if needed), `server/internal/messages/emoji_validate.go` (export `ValidUnicodeEmoji` for reuse, keeping the old name as an alias or updating callers), `server/internal/app/app.go` (routes, blob table), `server/internal/app/realtime.go` (READY `sounds`, schemas)

**Interfaces:**
- `type Sound struct{ ID id.ID; Name string; Emoji string; DurationMs int; URL string; CreatorID *id.ID }` (JSON `id`, `name`, `emoji`, `duration_ms`, `url`, `creator_id,omitempty`); `URL` = `/api/sounds/<id>`.
- `type SoundUpdate struct{ Sounds []Sound }` (JSON `sounds`).
- `(*Service).Sounds(ctx) ([]Sound, error)`, `(*Service).SoundExists(ctx, id) (bool, error)`.
- `audioInfo(data []byte) (contentType string, duration time.Duration, err error)`: `audio/ogg`, `audio/mpeg` or `audio/wav`.
- **Routes:**
  - `list-sounds` `GET /api/server/sounds` (members, gated included);
  - raw `POST /api/server/sounds` (multipart `name`, `emoji`, `file`) → 201 `Sound`;
  - `update-sound` `PATCH /api/server/sounds/{soundID}` `{name?, emoji?}`;
  - `delete-sound` `DELETE /api/server/sounds/{soundID}` → 204;
  - public raw `GET /api/sounds/{id}`.
- **Event:** `SOUND_UPDATE` (full list) after every change. **READY:** `sounds` (`[]` for non-members).
- **Errors:** `400 NOT_AUDIO` ("upload an OGG, MP3 or WAV file"), `400 TOO_LONG` ("sounds can be at most 5 seconds"), `413 TOO_LARGE` ("sounds can be at most 512 KB"), `400 SOUND_LIMIT` ("this server already has 100 sounds"), `400 INVALID_EMOJI`, `400 VALIDATION_FAILED` (name), `403`.

- [ ] **Step 1: Write the failing tests** — `server/internal/expressions/audio_test.go` builds tiny files in memory:

```go
package expressions

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// wav returns a PCM WAV of the given length (8 kHz, mono, 8-bit).
func wav(d time.Duration) []byte {
	const rate = 8000
	n := int(d.Seconds() * rate)
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(&b, binary.LittleEndian, uint16(1)) // channels
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate)) // byte rate
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(8))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n))
	b.Write(make([]byte, n))
	return b.Bytes()
}

// mp3 returns n silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz): 1152 samples each.
func mp3(frames int) []byte {
	header := []byte{0xFF, 0xFB, 0x90, 0x00}
	frameLen := 144 * 128000 / 44100 // 417, no padding
	var b bytes.Buffer
	b.WriteString("ID3\x03\x00\x00\x00\x00\x00\x00") // empty ID3v2 tag
	for i := 0; i < frames; i++ {
		b.Write(header)
		b.Write(make([]byte, frameLen-4))
	}
	return b.Bytes()
}

// opus returns a minimal Ogg Opus stream whose last granule position is granule (48 kHz, pre-skip 312).
func opus(granule int64) []byte {
	page := func(headerType byte, gp int64, seq uint32, body []byte) []byte {
		var b bytes.Buffer
		b.WriteString("OggS")
		b.WriteByte(0)
		b.WriteByte(headerType)
		binary.Write(&b, binary.LittleEndian, gp)
		binary.Write(&b, binary.LittleEndian, uint32(1)) // serial
		binary.Write(&b, binary.LittleEndian, seq)
		binary.Write(&b, binary.LittleEndian, uint32(0)) // CRC (not checked)
		b.WriteByte(1)
		b.WriteByte(byte(len(body)))
		b.Write(body)
		return b.Bytes()
	}
	head := append([]byte("OpusHead\x01\x01"), 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0) // pre-skip 312, 48 kHz
	return append(append(page(2, 0, 0, head), page(0, 0, 1, []byte("OpusTags"))...), page(4, granule, 2, []byte{0})...)
}

func TestAudioInfo(t *testing.T) {
	ct, d, err := audioInfo(wav(2 * time.Second))
	require.NoError(t, err)
	require.Equal(t, "audio/wav", ct)
	require.InDelta(t, 2.0, d.Seconds(), 0.01)

	ct, d, err = audioInfo(mp3(100)) // 100 × 1152 / 44100 ≈ 2.61 s
	require.NoError(t, err)
	require.Equal(t, "audio/mpeg", ct)
	require.InDelta(t, 2.61, d.Seconds(), 0.05)

	ct, d, err = audioInfo(opus(48000*3 + 312))
	require.NoError(t, err)
	require.Equal(t, "audio/ogg", ct)
	require.InDelta(t, 3.0, d.Seconds(), 0.01)

	_, _, err = audioInfo([]byte("hello, not audio"))
	require.Error(t, err)
	_, _, err = audioInfo(wav(0)[:20]) // truncated
	require.Error(t, err)
}
```

`server/internal/expressions/sounds_test.go`:
- Upload `wav(1s)` named "Airhorn" with 🎺 → 201, `duration_ms` ≈ 1000, `url` `/api/sounds/<id>`. `SOUND_UPDATE` reaches another member. The public GET returns `audio/wav`.
- `wav(6s)` → 400 `TOO_LONG`; text → 400 `NOT_AUDIO`; 600 KB → 413; emoji "lol" → 400 `INVALID_EMOJI`.
- A member without `MANAGE_EXPRESSIONS` → 403.
- Rename and emoji change via PATCH; delete → 204 and GET 404.
- Limit: insert 100 rows directly, then the next upload → 400 `SOUND_LIMIT`.
- READY has `sounds`.

Use the same multipart helper pattern as `expressions_test.go` (M5), with an `emoji` field.

- [ ] **Step 2: Run to verify they fail** — `go -C server test ./internal/expressions/ -run 'TestAudioInfo|TestSound'`. Expected: compile errors.

- [ ] **Step 3: Migration** — `server/internal/db/migrations/00018_sounds.sql`:

```sql
-- +goose Up
CREATE TABLE sounds (
    id           BIGINT PRIMARY KEY,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    emoji        TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    duration_ms  INT NOT NULL,
    creator_id   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sounds_sha_idx ON sounds (sha256);

-- +goose Down
DROP TABLE sounds;
```

- [ ] **Step 4: Audio parsing** — `server/internal/expressions/audio.go`:

```go
package expressions

import (
	"bytes"
	"encoding/binary"
	"errors"
	"time"
)

var errNotAudio = errors.New("not a supported audio file")

// audioInfo detects WAV, Ogg (Vorbis or Opus) and MP3 files and measures
// their length from the file itself (spec: sounds ≤ 5 s).
func audioInfo(data []byte) (string, time.Duration, error) {
	switch {
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE":
		d, err := wavDuration(data)
		return "audio/wav", d, err
	case len(data) >= 4 && string(data[:4]) == "OggS":
		d, err := oggDuration(data)
		return "audio/ogg", d, err
	case len(data) >= 3 && (string(data[:3]) == "ID3" || (data[0] == 0xFF && data[1]&0xE0 == 0xE0)):
		d, err := mp3Duration(data)
		return "audio/mpeg", d, err
	}
	return "", 0, errNotAudio
}

func wavDuration(data []byte) (time.Duration, error) {
	var byteRate uint32
	for i := 12; i+8 <= len(data); {
		id := string(data[i : i+4])
		size := int(binary.LittleEndian.Uint32(data[i+4 : i+8]))
		body := i + 8
		switch id {
		case "fmt ":
			if size < 16 || body+16 > len(data) {
				return 0, errNotAudio
			}
			byteRate = binary.LittleEndian.Uint32(data[body+8 : body+12])
		case "data":
			if byteRate == 0 {
				return 0, errNotAudio
			}
			if body+size > len(data) {
				size = len(data) - body // a truncated data chunk is measured as it is
			}
			return time.Duration(float64(size) / float64(byteRate) * float64(time.Second)), nil
		}
		i = body + size + size%2 // chunks are word-aligned
	}
	return 0, errNotAudio
}

func oggDuration(data []byte) (time.Duration, error) {
	// The first page's packet says the codec and its sample rate.
	if len(data) < 27 {
		return 0, errNotAudio
	}
	segs := int(data[26])
	first := 27 + segs
	if first > len(data) {
		return 0, errNotAudio
	}
	packet := data[first:]
	var rate, preSkip float64
	switch {
	case bytes.HasPrefix(packet, []byte("OpusHead")) && len(packet) >= 12:
		rate = 48000 // Opus granule positions are always at 48 kHz
		preSkip = float64(binary.LittleEndian.Uint16(packet[10:12]))
	case bytes.HasPrefix(packet, []byte("\x01vorbis")) && len(packet) >= 16:
		rate = float64(binary.LittleEndian.Uint32(packet[12:16]))
	default:
		return 0, errNotAudio
	}
	if rate == 0 {
		return 0, errNotAudio
	}
	// The last page's granule position is the stream length in samples.
	last := bytes.LastIndex(data, []byte("OggS"))
	if last < 0 || last+14 > len(data) {
		return 0, errNotAudio
	}
	granule := float64(int64(binary.LittleEndian.Uint64(data[last+6 : last+14])))
	samples := granule - preSkip
	if samples <= 0 {
		return 0, errNotAudio
	}
	return time.Duration(samples / rate * float64(time.Second)), nil
}

var (
	mp3Bitrates = [2][16]int{ // kbit/s for Layer III: [MPEG-1, MPEG-2/2.5][index]
		{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},
	}
	mp3Rates = [3][3]int{{44100, 48000, 32000}, {22050, 24000, 16000}, {11025, 12000, 8000}} // MPEG-1, 2, 2.5
)

func mp3Duration(data []byte) (time.Duration, error) {
	i := 0
	if len(data) >= 10 && string(data[:3]) == "ID3" { // skip an ID3v2 tag (syncsafe size)
		size := int(data[6]&0x7F)<<21 | int(data[7]&0x7F)<<14 | int(data[8]&0x7F)<<7 | int(data[9]&0x7F)
		i = 10 + size
	}
	var seconds float64
	frames := 0
	for i+4 <= len(data) {
		h := data[i : i+4]
		if h[0] != 0xFF || h[1]&0xE0 != 0xE0 {
			if frames > 0 {
				break // trailing tags (ID3v1, APE) end the frames
			}
			i++ // tolerate junk before the first frame
			continue
		}
		version := (h[1] >> 3) & 3 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
		layer := (h[1] >> 1) & 3   // 1 = Layer III
		bitrateIdx := h[2] >> 4
		rateIdx := (h[2] >> 2) & 3
		padding := int((h[2] >> 1) & 1)
		if version == 1 || layer != 1 || bitrateIdx == 0 || bitrateIdx == 15 || rateIdx == 3 {
			return 0, errNotAudio // only Layer III, no free-format
		}
		v := map[byte]int{3: 0, 2: 1, 0: 2}[version]
		rate := mp3Rates[v][rateIdx]
		bitrate := mp3Bitrates[min(v, 1)][bitrateIdx] * 1000
		samples, coef := 1152, 144
		if v > 0 {
			samples, coef = 576, 72
		}
		length := coef*bitrate/rate + padding
		if length < 4 {
			return 0, errNotAudio
		}
		seconds += float64(samples) / float64(rate)
		frames++
		i += length
	}
	if frames == 0 {
		return 0, errNotAudio
	}
	return time.Duration(seconds * float64(time.Second)), nil
}
```

(The MP3 check in `audioInfo` also accepts a raw frame sync; `mp3Duration` rejects anything that isn't Layer III. The functions never index beyond `len(data)`: keep the bounds checks if you restructure. Add a fuzz-style test that feeds random byte slices to `audioInfo` and asserts no panic. Use a fixed-seed `math/rand` loop of 1000 iterations, not `go test -fuzz`.)

- [ ] **Step 5: Sounds** — `server/internal/expressions/sounds.go`:
- Follow `handlers.go` (emoji) closely: same `require`, `publish`-style helper (`publishSounds` → `SOUND_UPDATE`), list query, `get`, rename and delete. Delete removes the blob with `RemoveBlobs`.
- `UploadSoundHandler()`:
  1. `require(MANAGE_EXPRESSIONS)`.
  2. `MaxBytesReader(512 KB + 64 KB)` and `ParseMultipartForm`; delete the temp files.
  3. Name: trim it; 1–32 characters.
  4. Emoji: `messages.ValidUnicodeEmoji(emoji)`.
  5. File: ≤ 512 KB → `audioInfo` → duration ≤ 5 s (`TOO_LONG`).
  6. In a transaction: advisory lock `hashtextextended('sounds', 0)`, count < 100, store the blob, insert, commit, publish.
- Store the blob with a new `files` method, `StoreBlob(ctx, tx, data []byte) (sum string, err error)`: stage, lock and commit like `StoreImageBlob`, but with no image processing. Add it next to `StoreImageBlob` in `files/blobs.go` and to the `Blobs` interface.
- `SoundImageHandler` → `SoundFileHandler()` for `GET /api/sounds/{id}`: `ServeBlob(w, r, sum, contentType, true)`.

In `app.go`, before `filesSvc.Start()`: `filesSvc.AddBlobTable("sounds", "sha256")`. Register the routes (huma outside `pool != nil`; raw handlers inside): `mux.Handle("POST /api/server/sounds", authSvc.RequireHTTP(exprSvc.UploadSoundHandler()))` and `mux.Handle("GET /api/sounds/{id}", exprSvc.SoundFileHandler())`. READY gains `Sounds []expressions.Sound \`json:"sounds"\``. Schemas: `expressions.SoundUpdate{}`.

Moving `validUnicodeEmoji` to an exported `messages.ValidUnicodeEmoji` creates an `expressions` → `messages` import. `messages` doesn't import `expressions` (it uses an interface), so there is no cycle. If there would be one, move the validator to a small shared package, `server/internal/emoji`.

- [ ] **Step 6: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...` (PowerShell). Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 7: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(expressions): soundboard sounds with server-side duration checks`

---

### Task 2: Playing sounds (server)

**Files:**
- Create: `server/internal/voice/soundboard.go`, `server/internal/voice/soundboard_test.go`
- Modify: `server/internal/voice/voice.go` (a `Sounds` interface, a rate limiter field, `SetSounds`), `handlers.go` (route), `server/internal/app/app.go` (wiring), `server/internal/app/realtime.go` (schema)

**Interfaces:**
- `type Sounds interface{ SoundExists(ctx, id id.ID) (bool, error) }`; `(*Service).SetSounds(Sounds)`.
- `type SoundboardPlay struct{ ChannelID, UserID, SoundID id.ID }` (JSON `channel_id`, `user_id`, `sound_id`).
- Route `play-sound` `POST /api/voice/soundboard` `{sound_id}` → 204.
- Event `SOUNDBOARD_PLAY` to the user IDs currently in that voice channel, the player included.
- **Errors:** `404` when the caller isn't in voice ("you are not in a voice call"); `404` for an unknown sound; `403 MISSING_PERMISSION` without `USE_SOUNDBOARD` or `SPEAK` in the call's channel; `403 SERVER_MUTED` ("a moderator muted you"); `429 RATE_LIMITED` (1 per 2 s per user).
- Calls in DMs: the fixed DM permission set lacks `USE_SOUNDBOARD`. Add it to `perms.DM` and the client's `DM_PERMS`, so the soundboard works in DM calls too.

- [ ] **Step 1: Write the failing test** — `server/internal/voice/soundboard_test.go`. Use the voice package's existing LiveKit-backed helpers (`liveKitEnv`, `newClub`, the join helpers in `helpers_test.go`):
  1. Alice and bob join the voice channel (as the existing join tests do, so the service registers them as participants), and carol is not in the call.
  2. Alice uploads a sound via the expressions route; use a WAV built like Task 1's `wav` helper.
  3. Alice plays it: bob's socket gets `SOUNDBOARD_PLAY` with `user_id` alice and the sound's ID; carol's socket gets nothing within 300 ms.
  4. Playing again at once → 429.
  5. Carol (not in voice) → 404.
  6. An unknown sound ID → 404.
  7. Server-mute bob (the existing mute route), then bob plays → 403 `SERVER_MUTED`.
  8. Remove `USE_SOUNDBOARD` from @everyone, then bob (unmuted) plays → 403 `MISSING_PERMISSION`.

  If waiting for LiveKit participation makes this slow, follow how `state_test.go` waits for a joined state.

- [ ] **Step 2: Run to verify it fails** — `go -C server test ./internal/voice/ -run TestSoundboard`. Expected: compile errors.

- [ ] **Step 3: Implement** — `server/internal/voice/soundboard.go`:

```go
package voice

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Sounds interface {
	SoundExists(ctx context.Context, soundID id.ID) (bool, error)
}

func (s *Service) SetSounds(x Sounds) { s.sounds = x }

type SoundboardPlay struct {
	ChannelID id.ID `json:"channel_id"`
	UserID    id.ID `json:"user_id"`
	SoundID   id.ID `json:"sound_id"`
}

type PlaySoundRequest struct {
	SoundID id.ID `json:"sound_id"`
}

// PlaySound tells everyone in the caller's call to play a sound.
func (s *Service) PlaySound(ctx context.Context, userID, soundID id.ID) error {
	s.mu.Lock()
	p := s.users[userID]
	var channelID id.ID
	var serverMute bool
	if p != nil {
		channelID, serverMute = p.channelID, p.serverMute
	}
	s.mu.Unlock()
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	if _, _, err := s.channels.Access(ctx, userID, channelID, perms.UseSoundboard|perms.Speak); err != nil {
		return err
	}
	if serverMute {
		return httpx.E(http.StatusForbidden, "SERVER_MUTED", "a moderator muted you")
	}
	if s.sounds == nil {
		return httpx.NotFound("sound")
	}
	ok, err := s.sounds.SoundExists(ctx, soundID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("sound")
	}
	if !s.soundLimit.Allow(userID.String()) {
		return httpx.RateLimited()
	}
	s.mu.Lock()
	var listeners []id.ID
	for uid, q := range s.users {
		if q.channelID == channelID {
			listeners = append(listeners, uid)
		}
	}
	s.mu.Unlock()
	s.bus.Publish(events.Event{Type: "SOUNDBOARD_PLAY", Data: SoundboardPlay{ChannelID: channelID, UserID: userID, SoundID: soundID},
		Scope: events.Scope{UserIDs: listeners}})
	return nil
}

func registerSoundboard(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("play-sound", http.MethodPost, "/api/voice/soundboard", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body PlaySoundRequest }) (*struct{}, error) {
			return nil, s.PlaySound(ctx, auth.Current(ctx).User.ID, in.Body.SoundID)
		})
}
```

Then:
- Add the fields `sounds Sounds` and `soundLimit *ratelimit.Limiter` (`ratelimit.New(30, 1)`: one every 2 s, burst 1) in `NewService`.
- Call `registerSoundboard(api, s, op)` from `Register`.
- `app.go`: `voiceSvc.SetSounds(exprSvc)`.
- `perms.DM` gains `| UseSoundboard`; update `perms_test.go` if it asserts the DM set.
- `registerEventSchemas` adds `voice.SoundboardPlay{}`.

The mutex and field names (`s.mu`, `s.users`, `p.serverMute`) are those in `voice.go`; adapt if they differ. Check how `States` locks.

- [ ] **Step 4: Run** — `go -C server vet ./...`; `go -C server test -p 2 ./...`. Expected: PASS. `gofmt -l server` empty.

- [ ] **Step 5: Regenerate the API client** — `pnpm -C clients/core run gen`, from PowerShell with `$env:GOTOOLCHAIN='local'`. Only `openapi.json` and `schema.d.ts` change under `clients/`.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(voice): soundboard plays sent to the call`

---
### Task 3: Core client — sounds and soundboard plays

**Files:**
- Modify: `clients/core/src/types.ts`, `store.ts`, `client.ts`, `perms.ts` and their tests

**Interfaces:**
- **Consumes:** the regenerated schema from Task 2 (`Sound`, `SoundUpdate`, `SoundboardPlay`, READY `sounds`, the `play-sound` route).
- **Types:** `Sound`, `SoundboardPlay`. `EventMap` gains `SOUND_UPDATE` and `SOUNDBOARD_PLAY`.
- **Store:**
  - `State.sounds: Record<string, Sound>`, from READY and `SOUND_UPDATE`.
  - Selector `soundList(s): Sound[]`, sorted by name. It returns a new array, so call it with `useShallow`.
  - `SOUNDBOARD_PLAY` doesn't change state. The web app listens through `client.onEvent`.
- **Client:** `uploadSound(name, emoji, file): Promise<Sound>` (multipart `name`, `emoji`, `file`), `updateSound(id, {name?, emoji?})`, `deleteSound(id)`, `playSound(soundId)`.
- **Perms:** `DM_PERMS` gains `Perm.UseSoundboard`.

- [ ] **Step 1: Write the failing tests:**
- READY with two sounds → `soundList` sorted by name.
- `SOUND_UPDATE` replaces the list, and a null list becomes `{}`.
- The client test checks that `playSound("9")` POSTs `/api/voice/soundboard` with `{sound_id: "9"}`.
- The perms test checks `hasPerm(DM_PERMS, Perm.UseSoundboard)`.

- [ ] **Step 2: Run to verify they fail** — `pnpm -C clients/core exec vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement** as described; for `uploadSound`, follow `uploadEmoji` (M5).
- [ ] **Step 4: Run** — core vitest, `pnpm -C clients/core exec tsc --noEmit`, `pnpm -C clients/web run typecheck`. Fix web type errors only where core shapes changed. Expected: PASS.
- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): sounds and soundboard plays`

---

### Task 4: Web — local voice settings (volume, mute for me, hide video)

**Files:**
- Create: `clients/web/src/voice/prefs.ts`, `clients/web/src/voice/prefs.test.ts`, `clients/web/src/voice/mixer.ts`, `clients/web/src/app/voice/PersonMenu.tsx`
- Modify: `clients/web/src/voice/voice.ts` (**few, self-contained hunks only — see Global Constraints**), `clients/web/src/app/voice/VoiceStage.tsx` and/or `VoiceMembers.tsx` (open `PersonMenu` from a tile or member; the badge)

**Interfaces:**
- **`prefs.ts`**, a small zustand store persisted to `localStorage` key `datrope.voicePrefs` (try/catch on every access; in-memory fallback):
  - `type VoicePrefs = { volume: Record<string, number>; mutedForMe: Record<string, boolean>; hideVideo: Record<string, boolean>; screenVolume: Record<string, number>; soundboardVolume: number; favourites: string[] }`.
  - Defaults: volume 100, `screenVolume` 100, `soundboardVolume` 60, `favourites` `[]`.
  - Exports: `voicePrefs` (the store), `useVoicePrefs(selector)`, `setVolume(userId, pct)` (clamped 0–200; 100 deletes the entry), `setMutedForMe(userId, on)`, `setHideVideo(userId, on)`, `setScreenVolume(userId, pct)`, `setSoundboardVolume(pct)` (0–100), `toggleFavourite(soundId)`, `isAdjusted(prefs, userId): boolean` (volume ≠ 100 or muted for me).
- **`mixer.ts`:** `applyPrefs(room: Room, deafened: boolean): void`. For each remote participant:
  - `setVolume(gain, Track.Source.Microphone)` where `gain = deafened || mutedForMe ? 0 : volume/100`;
  - `setVolume(screenGain, Track.Source.ScreenShareAudio)`;
  - the camera publication `setSubscribed(!hideVideo)`.

  `watchPrefs(getRoom: () => Room | undefined, getDeafened: () => boolean): () => void` subscribes to `voicePrefs` and re-applies.
- **`voice.ts` hooks** (the only changes there):
  1. the Room options gain `webAudioMix: true`;
  2. after `TrackSubscribed`, `ParticipantConnected` and in `applyAudio()`, call `applyPrefs(room, deafened)`;
  3. `join()` starts `watchPrefs(...)` and `disconnect()` stops it.

  Verify in `node_modules/livekit-client` (2.22.3) that `RemoteParticipant.setVolume(volume, source)` exists and allows gains above 1 with `webAudioMix`. Also confirm that deafen still silences everything once audio goes through Web Audio. If attached elements' `muted` flag no longer silences web-audio-mixed tracks, deafen must rely on the gain of 0 from `applyPrefs`; test it by reasoning and say so in the report.

**Behaviour:**
- **Opening the menu:** right-click, or the "More" button on a person's tile in the voice view, or their row under a voice channel in the sidebar (`VoiceMembers`), opens `PersonMenu`. It's a shadcn `Popover` per the mockup ("Carol's volume" and a percent value).
- **Menu contents:**
  - a slider, `input type=range` styled with tokens like the mockup's `.range`, 0–200 step 5, `aria-label="Volume for <Name>, just for you"`;
  - a "Mute for me" switch;
  - a "Hide video" switch, shown only when they have a camera;
  - "Reset", which appears when adjusted.
- **Not for yourself:** no menu on your own tile or row.
- **Badge:** a tile or row whose person `isAdjusted` shows a small badge, a lucide `Volume1` icon or `VolumeX` when muted for you, with `aria-label="Volume changed"` or `"Muted for you"`.
- **Hide video:** a hidden camera tile shows the avatar placeholder with the text "Video hidden".

- [ ] **Step 1: Write the failing test** — `clients/web/src/voice/prefs.test.ts` (stub `localStorage` in memory, as M6's `collapsed.test.ts` does):

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isAdjusted, setMutedForMe, setSoundboardVolume, setVolume, toggleFavourite, voicePrefs } from "./prefs";

describe("voice prefs", () => {
  beforeEach(() => voicePrefs.setState(voicePrefs.getInitialState(), true));

  it("clamps and forgets the default volume", () => {
    setVolume("u1", 250);
    expect(voicePrefs.getState().volume.u1).toBe(200);
    setVolume("u1", 100);
    expect("u1" in voicePrefs.getState().volume).toBe(false);
    setSoundboardVolume(150);
    expect(voicePrefs.getState().soundboardVolume).toBe(100);
  });

  it("knows who was adjusted", () => {
    expect(isAdjusted(voicePrefs.getState(), "u1")).toBe(false);
    setMutedForMe("u1", true);
    expect(isAdjusted(voicePrefs.getState(), "u1")).toBe(true);
  });

  it("toggles favourites", () => {
    toggleFavourite("s1");
    toggleFavourite("s2");
    toggleFavourite("s1");
    expect(voicePrefs.getState().favourites).toEqual(["s2"]);
  });
});
```

(If the zustand version has no `getInitialState`, keep a `defaults` constant and reset with it.)

- [ ] **Step 2: Run to verify it fails** — `pnpm -C clients/web exec vitest run src/voice/prefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `prefs.ts`, `mixer.ts`, the `voice.ts` hooks and the UI.
- [ ] **Step 4: Run** — `pnpm -C clients/web exec vitest run`, `pnpm -C clients/web run typecheck`, `pnpm -C clients/web run build`. Expected: PASS.
- [ ] **Step 5: Report the `voice.ts` hunks** — paste the exact `git diff` hunks you added to `clients/web/src/voice/voice.ts` into the report, separate from the user's existing unstaged hunks (`play("join")` / `play("leave")` / `import { play }`). The controller stages only yours.
- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): per-person volume, mute for me and hide video`

---

### Task 5: Web — voice channel view: stage and grid layouts, invite tile

**Files:**
- Create: `clients/web/src/app/voice/StageView.tsx`, `clients/web/src/app/voice/GridView.tsx`, `clients/web/src/app/voice/Tile.tsx`, `clients/web/src/app/voice/InviteTile.tsx`
- Modify: `clients/web/src/app/voice/VoiceChannelView.tsx` (header: "Grid layout" toggle, "Channel chat" from M6, "Soundboard" slot for Task 6), `clients/web/src/app/voice/VoiceStage.tsx` (split or replace with the views above, keeping today's watch/unwatch and video behaviour)

**Interfaces:**
- **Consumes:** `useVoice` (`tiles`, `watching`, `speaking`, `watch(userId, on)`), Task 4's `PersonMenu`, `useVoicePrefs`, `setScreenVolume`, `isAdjusted`, core `client.api` for invites.
- **Produces:**
  - `<Tile tile | person, size: "large" | "strip" | "grid", chip?: ReactNode />`: the speaking ring, name label, muted/deafened icons, adjusted badge, and a `chip` slot that Task 6 fills.
  - The layout state: `"grid" | "stage"`.

Build from `VoiceStage.dc.html` (stage) and `VoiceSoundboard.dc.html` (grid and invite tile):
- **Grid:** every participant gets a tile, a camera tile with video if they have a camera on, otherwise an avatar tile with initials. Screen shares not being watched appear as a small "<Name> is sharing their screen" tile with a "Watch" button.
- **Stage:** the first watched screen share is large. Its overlay has "Stop watching" (`watch(id, false)`), "Full screen" (Fullscreen API on the tile) and a screen-audio slider (`aria-label="Volume of <Name>'s screen audio"`, 0–200, `setScreenVolume`). Everyone else, and other watched shares, is in a horizontal strip below.
- **Switching layout:** watching a share switches to stage. The header "Grid layout" button (`aria-pressed` when grid) switches between the layouts. Stopping the last watched share returns to grid.
- **Invite tile:** in the grid, when the call has 1–4 people and you have `CREATE_INVITE`, show a dashed tile with "Invite someone to <channel>" and "Copy invite link". The button reuses an unlimited, non-expiring invite you created earlier if `GET /api/server/invites` lists one (`MANAGE_SERVER` only; otherwise just create one). Otherwise it calls `POST /api/server/invites {}`. It copies `${location.origin}/invite/<code>` with the M4 copy helper, which falls back on clipboard errors, and shows "Copied" for 2 s.
- **Empty call:** a "Join voice" call-to-action, as today.
- **Layout and colours:** the tiles are a responsive CSS grid on the `background` surface (not near-black, per the user's M4 feedback), with rounded corners and the speaking ring in `primary`.

- [ ] **Step 1: Build** the above, keeping existing behaviour (join, camera, screen share, watch, speaking indicators).
- [ ] **Step 2: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 3: Checkpoint** — stop. The controller reviews and checks in the browser, then stages. Suggested message: `feat(web): voice stage and grid layouts with an invite tile`

---

### Task 6: Web — soundboard panel and playback

**Files:**
- Create: `clients/web/src/voice/soundboard-audio.ts`, `clients/web/src/voice/soundboard-audio.test.ts`, `clients/web/src/app/voice/SoundboardPanel.tsx`
- Modify: `clients/web/src/app/voice/VoiceChannelView.tsx` (the header "Soundboard" button), `clients/web/src/app/voice/VoicePanel.tsx` (a "Soundboard" button in the sidebar call controls too, so it works from any view and in DM calls), `clients/web/src/app/voice/Tile.tsx` (chip), `clients/web/src/app/AppShell.tsx` or a small `SoundboardListener` component mounted once (`SOUNDBOARD_PLAY` handling)

**Interfaces:**
- **Consumes:** Task 3 (`soundList`, `client.playSound`, `SOUNDBOARD_PLAY`), Task 4 (`voicePrefs`: soundboard volume, favourites, `mutedForMe`), Task 5 (`Tile` chip slot), `useVoice` (current call channel, deafened).
- **`soundboard-audio.ts`:**
  - `playClip(url: string, volumePct: number): Promise<void>`: one lazily created `AudioContext`; it fetches and decodes each URL once (a promise cache) and plays it through a `GainNode`.
  - `preload(urls: string[])`.
  - `recentPlays` store: `Record<userId, { soundId: string; until: number }>`, set for 3 s on each play, with `useRecentPlay(userId)`.
  - `shouldPlay(event, me: { channelId?: string; deafened: boolean }, mutedForMe: Record<string, boolean>): boolean`: play only if `event.channel_id` is my call's channel, I'm not deafened, and the player isn't muted for me.

**Behaviour:**
- **Listener:** on `SOUNDBOARD_PLAY`, if `shouldPlay`, call `playClip(client.url(sound.url), soundboardVolume)`. Always record the recent play, even for a player you muted, so the chip shows.
- **Panel:** a `Popover` from the "Soundboard" header button (`aria-label="Soundboard"`), or a side panel if that fits the layout better, per `VoiceSoundboard.dc.html`:
  - the title "<channel> soundboard";
  - a "Search sounds" input;
  - a "Favourites" section first;
  - a grid of sound buttons: the emoji large, the name and the duration. Each is named "Play <name>, <d.d> s", has a star toggle ("Favourite", `aria-pressed`), and preloads on panel open;
  - "Add sound" (only with `MANAGE_EXPRESSIONS`; it links to Server settings → Soundboard);
  - the soundboard volume slider, `aria-label="Soundboard volume, just for you"`, 0–100;
  - the hint text from the mockup.
- **Click** calls `client.playSound(id)`. The sound plays when the event comes back to you. Errors, such as rate limited or server muted, show in the panel. **Shift-click** plays locally with `playClip` and sends nothing.
- **Disabled:** the button is disabled when you're not in a call, lack `USE_SOUNDBOARD` or `SPEAK`, or are server-muted (tooltip explains).
- **Chip:** the player's tile shows the chip from the mockup, a small primary-tinted pill with "<emoji> <name>", for 3 s.
- **Deleted sounds:** a play event for a deleted sound is ignored.

- [ ] **Step 1: Write the failing test** — `soundboard-audio.test.ts` tests `shouldPlay` (pure):
  - other channel → false;
  - deafened → false;
  - player muted for me → false;
  - normal → true.
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser, then stages. Suggested message: `feat(web): soundboard panel with local playback and tile chips`

---

### Task 7: Web — Soundboard settings

**Files:**
- Create: `clients/web/src/app/server-settings/Soundboard.tsx`, `clients/web/src/app/server-settings/soundCheck.ts`, `clients/web/src/app/server-settings/soundCheck.test.ts`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (the "Soundboard" section becomes real, visible with `MANAGE_EXPRESSIONS`)

**Interfaces:**
- **Consumes:** Task 3 (`uploadSound`, `updateSound`, `deleteSound`, `soundList`); the M5 `EmojiPicker` (Unicode only for sounds: `onPick` with `{ unicode }`; ignore custom).
- **Produces:** `checkSoundFile(file: File): string | null`, a client-side pre-check that returns an error message:
  - type not one of `audio/ogg`, `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/wave`, or an extension other than `.ogg`/`.opus`/`.mp3`/`.wav` → "Use an OGG, MP3 or WAV file";
  - size > 512 KB → "Larger than 512 KB".

  Duration is checked by the server; the page shows its `TOO_LONG` message.

**Page:**
- **Header:** "Soundboard", with the description "Short sounds anyone in a call can play. Up to 5 seconds each."
- **Add-sound form:** file picker (`aria-label="Choose a sound file"`), name input (from the file name), an emoji button that opens `EmojiPicker` (default 🔊), a "Preview" button (`playClip` with an object URL) and "Add sound".
- **List:** a shadcn `Table` with columns: the emoji (click to change), the name (inline rename), the duration, a "Play" preview, the added-by name and "Delete" with a confirm dialog ("Delete <name>?").
- **Count line:** "N of 100 used".

- [ ] **Step 1: Write the failing test** for `checkSoundFile`: a wav file of 1 KB → null; a `.txt` → type error; 600 KB `.mp3` → size error.
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — web vitest, typecheck, build. Expected: PASS.
- [ ] **Step 5: Checkpoint** — stop. The controller reviews and checks in the browser, then stages. Suggested message: `feat(web): soundboard settings`

---

### Task 8: End-to-end test and docs

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (plus a tiny WAV fixture under `clients/web/e2e/fixtures/`; generate a valid 0.5 s silent WAV in the test or commit a small file), `deploy/README.md` (features)

- [ ] **Step 1: Extend the e2e** — in the existing voice part, where alice and bob are both in the voice channel:
  1. Alice opens Server settings → Soundboard and adds "Boop" from the fixture, with emoji 🔔. Do this before joining voice, if that's simpler.
  2. In the call, alice opens "Soundboard" and clicks "Play Boop, 0.5 s". Bob's browser shows the chip "🔔 Boop" on alice's tile.
  3. Bob opens alice's person menu and sets "Volume for alice, just for you" to 150. Alice's tile in bob's browser shows the "Volume changed" badge.

  Don't assert actual audio output.
- [ ] **Step 2: Run** — the `datrope-e2e` stack with the scratchpad port override, then `pnpm --filter @datrope/web e2e`, then `down -v`, as in M6 Task 9. Never touch other containers, the user's dev servers, or the user's sound work-in-progress files. Expected: PASS.
- [ ] **Step 3: Docs** — `deploy/README.md` features: voice layouts, per-person volume and mute for me, the soundboard (limits).
- [ ] **Step 4: Full verification** — Go vet and test, `gofmt`, core vitest, web vitest, web build, e2e. Expected: all PASS.
- [ ] **Step 5: Checkpoint** — stop; the controller reviews and stages. Suggested message: `test(e2e): soundboard play and per-person volume; docs`
