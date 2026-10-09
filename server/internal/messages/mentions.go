package messages

import (
	"context"
	"regexp"
	"strings"

	"github.com/datrope/datrope/server/internal/id"
)

const maxMentions = 20

var (
	codeBlock  = regexp.MustCompile("(?s)```.*?(```|$)")
	inlineCode = regexp.MustCompile("`[^`\n]*`")
	mentionRe  = regexp.MustCompile(`(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]{2,})`)
)

// parseMentions returns the lower-cased usernames mentioned in content, in
// order of first appearance, without duplicates, ignoring code.
func parseMentions(content string) []string {
	text := inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " ")
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(text, -1) {
		name := strings.ToLower(strings.TrimRight(m[2], ".-")) // "@bob." ends a sentence
		if len(name) < 2 || len(name) > 32 || seen[name] {     // longer is not a username, not a prefix of one
			continue
		}
		seen[name] = true
		out = append(out, name)
		if len(out) == maxMentions {
			break
		}
	}
	return out
}

// mentionIDs resolves the users mentioned in content; unknown names are ignored.
func (s *Service) mentionIDs(ctx context.Context, content string) ([]id.ID, error) {
	out := []id.ID{}
	names := parseMentions(content)
	if len(names) == 0 {
		return out, nil
	}
	byName, err := s.users.UserIDsByUsername(ctx, names)
	if err != nil {
		return nil, err
	}
	for _, n := range names {
		if uid, ok := byName[n]; ok {
			out = append(out, uid)
		}
	}
	return out, nil
}
