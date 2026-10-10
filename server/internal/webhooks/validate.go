package webhooks

import (
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/messages"
)

// Discord's limits for execute-webhook, in characters.
const (
	maxContent     = 2000
	maxUsername    = 80
	maxEmbeds      = 10
	maxTitle       = 256
	maxDescription = 4096
	maxFields      = 25
	maxFieldName   = 256
	maxFieldValue  = 1024
	maxAuthorName  = 256
	maxFooter      = 2048
	maxEmbedText   = 6000 // all embeds' text together
	maxURL         = 2048
	maxColor       = 0xFFFFFF
)

func runes(s string) int { return utf8.RuneCountInString(s) }

// linkOK reports whether s is an http(s) URL that a message may link to or name as an image.
func linkOK(s string) bool {
	if len(s) > maxURL {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// validate checks b against Discord's limits and normalises embed timestamps
// to RFC 3339 in UTC. It returns what is wrong, or "" when b is fine.
func validate(b *executeBody) string {
	if runes(b.Content) > maxContent {
		return fmt.Sprintf("content must be %d or fewer characters", maxContent)
	}
	if runes(b.Username) > maxUsername {
		return fmt.Sprintf("username must be %d or fewer characters", maxUsername)
	}
	if b.AvatarURL != "" && !linkOK(b.AvatarURL) {
		return "avatar_url must be an http(s) URL"
	}
	if len(b.Embeds) > maxEmbeds {
		return fmt.Sprintf("embeds must be %d or fewer", maxEmbeds)
	}
	total := 0
	for i := range b.Embeds {
		problem, text := validateEmbed(&b.Embeds[i])
		if problem != "" {
			return fmt.Sprintf("embeds[%d]: %s", i, problem)
		}
		total += text
	}
	if total > maxEmbedText {
		return fmt.Sprintf("embeds must hold %d or fewer characters in total", maxEmbedText)
	}
	return ""
}

// validateEmbed checks one embed. It returns what is wrong (or "") and how
// many characters of text the embed holds.
func validateEmbed(e *messages.WebhookEmbed) (string, int) {
	switch {
	case runes(e.Title) > maxTitle:
		return fmt.Sprintf("title must be %d or fewer characters", maxTitle), 0
	case runes(e.Description) > maxDescription:
		return fmt.Sprintf("description must be %d or fewer characters", maxDescription), 0
	case e.URL != "" && !linkOK(e.URL):
		return "url must be an http(s) URL", 0
	case e.Color != nil && (*e.Color < 0 || *e.Color > maxColor):
		return fmt.Sprintf("color must be between 0 and %d", maxColor), 0
	case len(e.Fields) > maxFields:
		return fmt.Sprintf("fields must be %d or fewer", maxFields), 0
	case e.Title == "" && e.Description == "" && e.Author == nil && len(e.Fields) == 0 &&
		e.Thumbnail == nil && e.Image == nil && e.Footer == nil:
		return "an embed needs a title, description, author, field, image, thumbnail or footer", 0
	}
	text := runes(e.Title) + runes(e.Description)
	if e.Timestamp != "" {
		t, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil {
			return "timestamp must be an ISO 8601 date and time", 0
		}
		e.Timestamp = t.UTC().Format(time.RFC3339)
	}
	if a := e.Author; a != nil {
		switch {
		case strings.TrimSpace(a.Name) == "":
			return "author.name is required", 0
		case runes(a.Name) > maxAuthorName:
			return fmt.Sprintf("author.name must be %d or fewer characters", maxAuthorName), 0
		case a.URL != "" && !linkOK(a.URL):
			return "author.url must be an http(s) URL", 0
		case a.IconURL != "" && !linkOK(a.IconURL):
			return "author.icon_url must be an http(s) URL", 0
		}
		text += runes(a.Name)
	}
	for j, f := range e.Fields {
		switch {
		case strings.TrimSpace(f.Name) == "" || strings.TrimSpace(f.Value) == "":
			return fmt.Sprintf("fields[%d] needs a name and a value", j), 0
		case runes(f.Name) > maxFieldName:
			return fmt.Sprintf("fields[%d].name must be %d or fewer characters", j, maxFieldName), 0
		case runes(f.Value) > maxFieldValue:
			return fmt.Sprintf("fields[%d].value must be %d or fewer characters", j, maxFieldValue), 0
		}
		text += runes(f.Name) + runes(f.Value)
	}
	if e.Thumbnail != nil && !linkOK(e.Thumbnail.URL) {
		return "thumbnail.url must be an http(s) URL", 0
	}
	if e.Image != nil && !linkOK(e.Image.URL) {
		return "image.url must be an http(s) URL", 0
	}
	if f := e.Footer; f != nil {
		switch {
		case strings.TrimSpace(f.Text) == "":
			return "footer.text is required", 0
		case runes(f.Text) > maxFooter:
			return fmt.Sprintf("footer.text must be %d or fewer characters", maxFooter), 0
		case f.IconURL != "" && !linkOK(f.IconURL):
			return "footer.icon_url must be an http(s) URL", 0
		}
		text += runes(f.Text)
	}
	return "", text
}
