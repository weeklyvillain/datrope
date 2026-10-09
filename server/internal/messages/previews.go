package messages

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
)

// Previews is what this package needs from linkpreview.
type Previews interface {
	Get(ctx context.Context, rawURL string) (*linkpreview.Preview, error)
}

func (s *Service) SetPreviews(p Previews) { s.previews = p }

// Wait blocks until background preview work has finished.
func (s *Service) Wait() { s.bg.Wait() }

var (
	spoilerRe = regexp.MustCompile(`(?s)\|\|.*?\|\|`)
	linkRe    = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+`)
)

// maxLinkLen is the longest link worth previewing; a longer first link means no preview.
const maxLinkLen = 2048

// firstLink returns the first http(s) link outside code and spoilers.
func firstLink(content string) string {
	text := spoilerRe.ReplaceAllString(inlineCode.ReplaceAllString(codeBlock.ReplaceAllString(content, " "), " "), " ")
	link := linkRe.FindString(text)
	for link != "" {
		last := link[len(link)-1]
		switch {
		case strings.ContainsRune(".,!?:;'\"", rune(last)):
			link = link[:len(link)-1]
		case last == ')' && strings.Count(link, "(") < strings.Count(link, ")"):
			link = link[:len(link)-1]
		case last == ']':
			link = link[:len(link)-1]
		case len(link) > maxLinkLen:
			return ""
		default:
			return link
		}
	}
	return ""
}

// attachPreview looks up the first link of a message in the background and,
// if the message's first link is still the same, stores and publishes the embed.
func (s *Service) attachPreview(m Message) {
	if s.previews == nil {
		return
	}
	link := firstLink(m.Content)
	if link == "" {
		return
	}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		p, err := s.previews.Get(ctx, link)
		if err != nil {
			slog.WarnContext(ctx, "link preview", "message", m.ID, "err", err)
			return
		}
		if p == nil {
			return
		}
		embed, err := json.Marshal(p)
		if err != nil {
			return
		}
		// An edit meanwhile that keeps the link (it attaches no preview of its own)
		// still gets this one; one that changes the link attaches its own.
		var content string
		if err := s.db.QueryRow(ctx, `SELECT content FROM messages WHERE id = $1 AND NOT deleted`, m.ID).Scan(&content); err != nil {
			return // deleted meanwhile
		}
		if firstLink(content) != link {
			return
		}
		tag, err := s.db.Exec(ctx, `UPDATE messages SET embed = $2 WHERE id = $1 AND content = $3 AND NOT deleted`, m.ID, embed, content)
		if err != nil || tag.RowsAffected() == 0 {
			return // edited or deleted between the two statements; that change decides
		}
		s.publishUpdated(ctx, m.ChannelID, m.ID)
	}()
}

// publishUpdated re-reads a message and publishes MESSAGE_UPDATE.
func (s *Service) publishUpdated(ctx context.Context, channelID, messageID id.ID) {
	m, err := scanMessage(s.db.QueryRow(ctx, `SELECT `+messageCols+` FROM messages WHERE id = $1 AND NOT deleted`, messageID))
	if err != nil {
		return
	}
	ms := []Message{*m}
	if err := s.hydrate(ctx, ms); err != nil {
		return
	}
	s.publish("MESSAGE_UPDATE", channelID, ms[0])
}
