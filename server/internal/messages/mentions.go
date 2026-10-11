package messages

import (
	"context"
	"regexp"
	"strings"

	"github.com/datrope/datrope/server/internal/id"
)

const maxMentions = 20

var (
	codeBlock     = regexp.MustCompile("(?s)```.*?(```|$)")
	inlineCode    = regexp.MustCompile("`[^`\n]*`")
	mentionRe     = regexp.MustCompile(`(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]{2,})`)
	everyoneRe    = regexp.MustCompile(`(^|[^A-Za-z0-9_.@-])@everyone([^A-Za-z0-9_]|$)`)
	roleMentionRe = regexp.MustCompile(`<@&(\d{1,20})>`)
)

// mentionsEveryone reports whether content pings @everyone outside code.
func mentionsEveryone(content string) bool {
	return everyoneRe.MatchString(inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " "))
}

// parseMentions returns the lower-cased usernames mentioned in content, in
// order of first appearance, without duplicates, ignoring code.
func parseMentions(content string) []string {
	text := inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " ")
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(text, -1) {
		name := strings.ToLower(strings.TrimRight(m[2], ".-"))                   // "@bob." ends a sentence
		if len(name) < 2 || len(name) > 32 || seen[name] || name == "everyone" { // longer is not a username, not a prefix of one
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

// mentionIDs resolves the users mentioned in content; unknown names are ignored.
func (s *Service) mentionIDs(ctx context.Context, content string) ([]id.ID, error) {
	return s.resolveMentions(ctx, parseMentions(content))
}

// resolveMentions turns mentioned usernames into user IDs, in order; unknown names are ignored.
func (s *Service) resolveMentions(ctx context.Context, names []string) ([]id.ID, error) {
	out := []id.ID{}
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
