package push

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/channels"
)

// Payload is what the service worker receives (clients/web/src/sw.ts).
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
	Icon  string `json:"icon,omitempty"` // the server icon; empty: Datrope's
}

const maxBody = 120

// Same steps as notificationBody in clients/web/src/notify/notify.ts. RE2 has no
// lookahead, so the italic step is done by stripItalics instead of one regex.
var bodyRules = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`\|\|[\s\S]+?\|\|`), "(spoiler)"},
	{regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`), "$1"},
	{regexp.MustCompile("\x60\x60\x60[^\\n]*\\n?"), ""},
	{regexp.MustCompile("\\*\\*|__|~~|\x60"), ""},
	{regexp.MustCompile(`(?m)^\s*#{1,6}\s+`), ""},
	{regexp.MustCompile(`(?m)^\s*[-*+]\s+`), ""},
	{regexp.MustCompile(`(?m)^\s*>\s?`), ""},
}

// italicRe finds a candidate *x* or _x_. The closing delimiter is checked by hand (stripItalics).
var italicRe = regexp.MustCompile(`(^|[\s(])([*_])([^*_\n]+)[*_]`)

// stripItalics keeps the emphasised text and drops its markers, when the closing
// marker is followed by the end, a space, or punctuation. The trailing character is
// left unconsumed so adjacent emphases such as "*a* *b*" both match.
func stripItalics(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range italicRe.FindAllStringSubmatchIndex(s, -1) {
		start, end := m[0], m[1]
		if s[m[4]] != s[end-1] { // JS needs the same delimiter (\2)
			continue
		}
		if end < len(s) {
			r, _ := utf8.DecodeRuneInString(s[end:])
			if !unicode.IsSpace(r) && !strings.ContainsRune(").,!?:;", r) {
				continue
			}
		}
		b.WriteString(s[last:start])
		b.WriteString(s[m[2]:m[3]]) // leading group
		b.WriteString(s[m[6]:m[7]]) // emphasised text
		last = end                  // the closing marker (at end-1) is dropped; the next char is copied as-is
	}
	b.WriteString(s[last:])
	return b.String()
}

// body is the message as plain text, cut to 120 characters. It never carries spoilers.
func body(content string, attachments int) string {
	text := content
	for _, r := range bodyRules {
		text = r.re.ReplaceAllString(text, r.with)
	}
	text = stripItalics(text)
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		switch attachments {
		case 0:
			return ""
		case 1:
			return "Sent a file"
		default:
			return fmt.Sprintf("Sent %d files", attachments)
		}
	}
	runes := []rune(text)
	if len(runes) <= maxBody {
		return text
	}
	return string(runes[:maxBody-1]) + "…"
}

// title names the author and where they wrote. parent is a thread's parent channel, if known.
func title(author string, webhook bool, ch, parent *channels.Channel) string {
	if webhook {
		author += " (webhook)"
	}
	if ch.Type == "dm" {
		if ch.Group && ch.Name != "" {
			return author + " in " + ch.Name
		}
		return author + " (direct message)"
	}
	name := ch.Name
	if ch.ParentChannelID != nil && parent != nil && parent.Name != "" {
		name = parent.Name
	}
	if name == "" {
		return author + " in a thread"
	}
	return author + " in #" + name
}

// target is the in-app route a tap opens and the tag that collapses repeats.
func target(ch *channels.Channel) (url, tag string) {
	tag = "channel:" + ch.ID.String()
	switch {
	case ch.Type == "dm":
		return "/messages/" + ch.ID.String(), tag
	case ch.ParentChannelID != nil:
		return "/channels/" + ch.ParentChannelID.String(), tag
	default:
		return "/channels/" + ch.ID.String(), tag
	}
}
