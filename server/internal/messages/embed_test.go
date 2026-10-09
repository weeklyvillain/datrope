package messages_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/messages"
)

type fakePreviews map[string]*linkpreview.Preview

func (f fakePreviews) Get(_ context.Context, rawURL string) (*linkpreview.Preview, error) {
	return f[rawURL], nil
}

func TestLinkPreviewAttached(t *testing.T) {
	env := apptest.New(t)
	defer env.App.Messages.Wait()
	env.App.Messages.SetPreviews(fakePreviews{
		"https://example.com": {URL: "https://example.com", Site: "Example", Title: "Example Domain", Description: "For examples."},
	})
	alice := env.Register("alice")
	general := alice.General()
	path := "/api/channels/" + general.String() + "/messages"
	ws, _ := alice.Connect()

	m := alice.Send(general, "look https://example.com")
	var up messages.Message
	ws.ExpectDispatch("MESSAGE_UPDATE", &up)
	require.Equal(t, m.ID, up.ID)
	require.NotNil(t, up.Embed)
	require.Equal(t, "Example Domain", up.Embed.Title)
	require.Equal(t, "https://example.com", up.Embed.URL)

	latest := func() messages.Message { // a fresh slice: Unmarshal keeps fields a reused element omits
		var page []messages.Message
		alice.Do(http.MethodGet, path, nil, http.StatusOK, &page)
		return page[0]
	}
	got := latest()
	require.NotNil(t, got.Embed)
	require.Equal(t, "Example Domain", got.Embed.Title)

	// Editing the text around the same link keeps the embed.
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "see https://example.com!"}, http.StatusOK, nil)
	up = messages.Message{}
	ws.ExpectDispatch("MESSAGE_UPDATE", &up)
	require.Equal(t, "see https://example.com!", up.Content)
	require.NotNil(t, up.Embed)
	env.App.Messages.Wait()
	ws.ExpectNoDispatch("MESSAGE_UPDATE", 300*time.Millisecond)
	require.NotNil(t, latest().Embed)

	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "never mind"}, http.StatusOK, nil)
	up = messages.Message{} // Unmarshal leaves an omitted embed as it was
	ws.ExpectDispatch("MESSAGE_UPDATE", &up)
	require.Equal(t, "never mind", up.Content)
	require.Nil(t, up.Embed)
	env.App.Messages.Wait()
	require.Nil(t, latest().Embed)

	// A link without a preview attaches nothing.
	alice.Send(general, "https://nothing.example")
	env.App.Messages.Wait()
	require.Nil(t, latest().Embed)
}

type gatedPreviews struct {
	fakePreviews
	gate chan struct{}
}

func (g gatedPreviews) Get(ctx context.Context, rawURL string) (*linkpreview.Preview, error) {
	<-g.gate
	return g.fakePreviews.Get(ctx, rawURL)
}

func TestLinkPreviewSurvivesQuickEdit(t *testing.T) {
	env := apptest.New(t)
	defer env.App.Messages.Wait()
	gate := make(chan struct{})
	env.App.Messages.SetPreviews(gatedPreviews{fakePreviews{
		"https://example.com": {URL: "https://example.com", Title: "Example Domain"},
	}, gate})
	alice := env.Register("alice")
	general := alice.General()
	path := "/api/channels/" + general.String() + "/messages"
	ws, _ := alice.Connect()

	m := alice.Send(general, "look https://example.com")
	// Edited around the same link while the preview is still loading.
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "look at https://example.com"}, http.StatusOK, nil)
	var up messages.Message
	ws.ExpectDispatch("MESSAGE_UPDATE", &up)
	require.Nil(t, up.Embed)
	close(gate)
	up = messages.Message{}
	ws.ExpectDispatch("MESSAGE_UPDATE", &up)
	require.Equal(t, "look at https://example.com", up.Content)
	require.NotNil(t, up.Embed)
	require.Equal(t, "Example Domain", up.Embed.Title)
}
