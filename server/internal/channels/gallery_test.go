package channels_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func getChannel(t *testing.T, c *apptest.Client, chID id.ID) channels.Channel {
	t.Helper()
	var ch channels.Channel
	c.Do(http.MethodGet, "/api/channels/"+chID.String(), nil, http.StatusOK, &ch)
	return ch
}

func TestGallerySourcesCreate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	base := "/api/server/channels"

	plain := getChannel(t, alice, alice.CreateGallery("photos", ""))
	require.Equal(t, channels.SourcesNone, plain.GallerySources, "galleries default to their own posts only")
	require.Empty(t, plain.SourceChannelIDs)

	all := getChannel(t, alice, alice.CreateGallery("everything", "all"))
	require.Equal(t, channels.SourcesAll, all.GallerySources)

	picked := getChannel(t, alice, alice.CreateGallery("picked", "selected", memes, general, memes))
	require.Equal(t, channels.SourcesSelected, picked.GallerySources)
	require.ElementsMatch(t, []id.ID{general, memes}, picked.SourceChannelIDs, "duplicates collapse")

	text := getChannel(t, alice, general)
	require.Empty(t, text.GallerySources, "only galleries have sources")

	welcome := alice.Channels()[0].ID
	d := alice.OpenDM(env.Register("bob").User.ID)
	for _, body := range []map[string]any{
		{"name": "x", "type": "text", "gallery_sources": "all"},                                                  // sources on text
		{"name": "x", "type": "gallery", "gallery_sources": "all", "source_channel_ids": []id.ID{general}},       // ids without selected
		{"name": "x", "type": "gallery", "gallery_sources": "selected"},                                          // selected without ids
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{welcome}},  // welcome
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{d}},        // a DM
		{"name": "x", "type": "gallery", "gallery_sources": "selected", "source_channel_ids": []id.ID{id.New()}}, // unknown
		{"name": "x", "type": "gallery", "gallery_sources": "some"},                                              // bad mode
	} {
		alice.Fail(http.MethodPost, base, body, http.StatusBadRequest, "VALIDATION_FAILED")
	}
}

func TestGallerySourcesUpdate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	memes := alice.CreateTextChannel("memes")
	g := alice.CreateGallery("photos", "")
	path := "/api/channels/" + g.String()

	var got channels.Channel
	alice.Do(http.MethodPatch, path, map[string]any{"gallery_sources": "selected", "source_channel_ids": []id.ID{memes}}, http.StatusOK, &got)
	require.Equal(t, []id.ID{memes}, got.SourceChannelIDs)

	// Changing only the ids keeps the mode.
	alice.Do(http.MethodPatch, path, map[string]any{"source_channel_ids": []id.ID{general}}, http.StatusOK, &got)
	require.Equal(t, channels.SourcesSelected, got.GallerySources)
	require.Equal(t, []id.ID{general}, got.SourceChannelIDs)

	// Switching to all drops the list; switching back needs a fresh one.
	got = channels.Channel{} // omitempty drops the field, so decoding would keep the old list
	alice.Do(http.MethodPatch, path, map[string]any{"gallery_sources": "all"}, http.StatusOK, &got)
	require.Empty(t, got.SourceChannelIDs)
	alice.Fail(http.MethodPatch, path, map[string]any{"gallery_sources": "selected"}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPatch, path, map[string]any{"source_channel_ids": []id.ID{g}}, http.StatusBadRequest, "VALIDATION_FAILED")

	alice.Fail(http.MethodPatch, "/api/channels/"+general.String(), map[string]any{"gallery_sources": "all"}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPatch, path, map[string]any{"gallery_sources": "none"}, http.StatusForbidden, "MISSING_PERMISSION")

	// The change is in the audit log.
	var log struct {
		Entries []struct {
			Action  string `json:"action"`
			Details struct {
				Changes []struct {
					Field string `json:"field"`
				} `json:"changes"`
			} `json:"details"`
		} `json:"entries"`
	}
	alice.Do(http.MethodGet, "/api/server/audit-log", nil, http.StatusOK, &log)
	require.Equal(t, "channel.update", log.Entries[0].Action)
	require.Equal(t, "gallery_sources", log.Entries[0].Details.Changes[0].Field)
}

func TestGallerySourceDeleted(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	memes := alice.CreateTextChannel("memes")
	g := alice.CreateGallery("photos", "selected", memes)
	alice.Do(http.MethodDelete, "/api/channels/"+memes.String(), nil, http.StatusNoContent, nil)
	got := getChannel(t, alice, g)
	require.Equal(t, channels.SourcesSelected, got.GallerySources)
	require.Empty(t, got.SourceChannelIDs)
}

func TestGalleryScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	srv := alice.Server()
	general := alice.General()
	secret := alice.CreatePrivateChannel("secret")
	ctx := context.Background()
	scope := func(c *apptest.Client, g id.ID) []id.ID {
		t.Helper()
		got, err := env.App.Channels.GalleryScope(ctx, c.User.ID, g)
		require.NoError(t, err)
		return got
	}

	none := alice.CreateGallery("photos", "")
	require.Equal(t, []id.ID{none}, scope(bob, none))

	all := alice.CreateGallery("everything", "all")
	require.ElementsMatch(t, []id.ID{general, none, all}, scope(bob, all), "bob can't read #secret")
	later := alice.CreateTextChannel("later")
	require.Contains(t, scope(bob, all), later, "all includes channels made later")
	require.Contains(t, scope(alice, all), secret)

	picked := alice.CreateGallery("picked", "selected", secret, general)
	require.ElementsMatch(t, []id.ID{picked, general}, scope(bob, picked))

	// Without READ_HISTORY in the gallery itself, its own posts drop out but sources stay.
	alice.Do(http.MethodPut, "/api/channels/"+picked.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	require.Equal(t, []id.ID{general}, scope(bob, picked))

	// A gallery bob can't see is a 404; a text channel is not a gallery.
	hidden := alice.CreateGallery("hidden", "all")
	alice.Do(http.MethodPut, "/api/channels/"+hidden.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	_, err := env.App.Channels.GalleryScope(ctx, bob.User.ID, hidden)
	requireHTTP(t, err, http.StatusNotFound)
	_, err = env.App.Channels.GalleryScope(ctx, bob.User.ID, general)
	requireHTTP(t, err, http.StatusBadRequest)
}

func requireHTTP(t *testing.T, err error, status int) {
	t.Helper()
	var he *httpx.Error
	require.ErrorAs(t, err, &he)
	require.Equal(t, status, he.Status)
}
