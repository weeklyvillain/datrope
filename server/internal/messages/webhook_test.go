package messages

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWebhookPostImageURLs(t *testing.T) {
	p := WebhookPost{AvatarURL: "https://x/a.png", Embeds: []WebhookEmbed{
		{Author: &EmbedAuthor{Name: "a", IconURL: "https://x/a.png"}, Thumbnail: &EmbedImage{URL: "https://x/t.png"}},
		{Image: &EmbedImage{URL: "https://x/i.png"}, Footer: &EmbedFooter{Text: "f", IconURL: "https://x/f.png"}},
		{Title: "no images"},
	}}
	require.Equal(t, []string{"https://x/a.png", "https://x/t.png", "https://x/i.png", "https://x/f.png"}, p.ImageURLs())
	require.Empty(t, WebhookPost{Content: "hi"}.ImageURLs())
}

func TestLocalEmbeds(t *testing.T) {
	in := []WebhookEmbed{{
		Title: "t", URL: "https://example.com",
		Author:    &EmbedAuthor{Name: "a", URL: "https://example.com/a", IconURL: "https://x/gone.png"},
		Thumbnail: &EmbedImage{URL: "https://x/gone.png"},
		Image:     &EmbedImage{URL: "https://x/ok.png"},
		Footer:    &EmbedFooter{Text: "f", IconURL: "https://x/ok.png"},
	}}
	out := localEmbeds(in, func(remote string) string {
		if remote == "https://x/ok.png" {
			return "/api/messages/1/images/abc"
		}
		return ""
	})
	require.Len(t, out, 1)
	e := out[0]
	require.Equal(t, "https://example.com", e.URL, "links stay as they are")
	require.Equal(t, "https://example.com/a", e.Author.URL)
	require.Empty(t, e.Author.IconURL, "an image that was not stored is dropped")
	require.Nil(t, e.Thumbnail)
	require.Equal(t, "/api/messages/1/images/abc", e.Image.URL)
	require.Equal(t, "/api/messages/1/images/abc", e.Footer.IconURL)
	require.Equal(t, "https://x/gone.png", in[0].Author.IconURL, "the input is not changed")
}
