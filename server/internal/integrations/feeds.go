package integrations

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/jackc/pgx/v5"
	"golang.org/x/net/html/charset"
	"golang.org/x/sync/errgroup"
)

// feed is an RSS 2.0 or Atom feed, cut to what alerts need.
type feed struct {
	Title   string
	Entries []feedEntry // in the feed's order: newest first
}

type feedEntry struct {
	ID    string // <guid> or <id>, else the link
	Title string
	Link  string
	Body  string // HTML
}

var errNotFeed = errors.New("not an RSS or Atom feed")

type atomLinkEl struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
}

// feedDoc decodes both formats: RSS fills Channel, Atom fills Title and Entries.
type feedDoc struct {
	XMLName xml.Name
	Channel struct {
		Title string `xml:"title"`
		Items []struct {
			Title   string `xml:"title"`
			Link    string `xml:"link"`
			GUID    string `xml:"guid"`
			Desc    string `xml:"description"`
			Content string `xml:"http://purl.org/rss/1.0/modules/content/ encoded"`
		} `xml:"item"`
	} `xml:"channel"`
	Title   string `xml:"title"`
	Entries []struct {
		Title   string       `xml:"title"`
		ID      string       `xml:"id"`
		Links   []atomLinkEl `xml:"link"`
		Content string       `xml:"content"`
		Summary string       `xml:"summary"`
	} `xml:"entry"`
}

// parseFeed reads an RSS 2.0 or Atom document in any charset.
func parseFeed(r io.Reader) (*feed, error) {
	d := xml.NewDecoder(r)
	d.CharsetReader = charset.NewReaderLabel
	d.Entity = xml.HTMLEntity // feeds use &nbsp; and friends
	var doc feedDoc
	if err := d.Decode(&doc); err != nil {
		return nil, fmt.Errorf("%w: %v", errNotFeed, err)
	}
	f := &feed{}
	switch doc.XMLName.Local {
	case "rss":
		f.Title = doc.Channel.Title
		for _, it := range doc.Channel.Items {
			body := it.Content
			if body == "" {
				body = it.Desc
			}
			f.add(feedEntry{ID: it.GUID, Title: it.Title, Link: it.Link, Body: body})
		}
	case "feed":
		f.Title = doc.Title
		for _, en := range doc.Entries {
			body := en.Content
			if body == "" {
				body = en.Summary
			}
			f.add(feedEntry{ID: en.ID, Title: en.Title, Link: alternateLink(en.Links), Body: body})
		}
	default:
		return nil, errNotFeed
	}
	f.Title = strings.TrimSpace(f.Title)
	return f, nil
}

// add keeps an entry when something identifies it.
func (f *feed) add(e feedEntry) {
	e.ID, e.Title, e.Link = strings.TrimSpace(e.ID), strings.TrimSpace(e.Title), strings.TrimSpace(e.Link)
	if e.ID == "" {
		e.ID = e.Link
	}
	if e.ID != "" {
		f.Entries = append(f.Entries, e)
	}
}

// alternateLink is an Atom entry's page: its rel="alternate" link, the
// default rel.
func alternateLink(links []atomLinkEl) string {
	for _, l := range links {
		if l.Rel == "" || l.Rel == "alternate" {
			return l.Href
		}
	}
	return ""
}

// feedMessage is the post for one entry: its title, its body as Markdown cut
// to maxFeedBody characters, and its link.
func feedMessage(e feedEntry) string {
	title := strings.TrimSpace(html.UnescapeString(e.Title))
	if title == "" {
		title = "New post"
	}
	if r := []rune(title); len(r) > maxFeedTitle {
		title = string(r[:maxFeedTitle]) + "…"
	}
	parts := []string{"📰 **" + escapeMarkdown(title) + "**"}
	if body := cutMarkdown(feedMarkdown(e.Body), maxFeedBody); body != "" {
		parts = append(parts, body)
	}
	if link := linkOf(e.Link); link != "" && len(link) <= maxFeedLink {
		parts = append(parts, link)
	}
	return strings.Join(parts, "\n")
}

const (
	maxFeedSize = 2 << 20 // bytes read from a feed
	maxFeedName = 100     // characters of a feed's name

	maxFeedTitle = 200  // characters of an entry's title
	maxFeedLink  = 2048 // longer links are left out

	// One slow feed must not use up the poll round: fetch up to
	// feedFetchers at a time, each with its own deadline.
	feedFetchers     = 8
	feedFetchTimeout = 10 * time.Second
)

// fetchFeed downloads and parses a feed through s.feeds, which refuses
// private addresses.
func (s *Service) fetchFeed(ctx context.Context, rawURL string) (*feed, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Datrope feed alerts")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5")
	res, err := s.feeds.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("feed: %s", res.Status)
	}
	return parseFeed(io.LimitReader(res.Body, maxFeedSize))
}

// feedURLOf accepts an absolute http(s) URL.
func feedURLOf(input string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(input))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	return u.String(), true
}

// feedName is what an alert posts under: the name given, else the feed's
// title, else the feed's host.
func feedName(given, title, rawURL string) string {
	for _, n := range []string{given, title} {
		if n = strings.TrimSpace(n); n != "" {
			if r := []rune(n); len(r) > maxFeedName {
				n = string(r[:maxFeedName])
			}
			return n
		}
	}
	u, _ := url.Parse(rawURL)
	return u.Host
}

// maxFeedPosts is how many entries one alert posts per round.
const maxFeedPosts = 5

// newEntries are the entries above last, newest first and at most
// maxFeedPosts. If last is gone (the feed rewrote its IDs, or it was empty
// when followed), only the newest entry counts as new.
func newEntries(entries []feedEntry, last string) []feedEntry {
	if len(entries) == 0 || entries[0].ID == last {
		return nil
	}
	for i, e := range entries {
		if e.ID == last {
			return entries[:min(i, maxFeedPosts)]
		}
	}
	return entries[:1]
}

func titleMatches(title, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(title), strings.ToLower(filter))
}

// pollFeeds posts each followed feed's new entries, fetching each URL once.
// A feed that fails is skipped until the next round.
func (s *Service) pollFeeds(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, account, display_name, last_item, title_filter FROM stream_alerts WHERE platform = 'rss' ORDER BY id`)
	if err != nil {
		return err
	}
	type alert struct {
		id, channelID           int64
		url, name, last, filter string
	}
	alerts, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (alert, error) {
		var a alert
		return a, r.Scan(&a.id, &a.channelID, &a.url, &a.name, &a.last, &a.filter)
	})
	if err != nil {
		return err
	}
	feeds := map[string]*feed{} // nil: the fetch failed this round; written under mu until g.Wait
	var urls []string           // the distinct URLs, so no goroutine overlaps a map iteration
	for _, a := range alerts {
		if _, seen := feeds[a.url]; !seen {
			feeds[a.url] = nil
			urls = append(urls, a.url)
		}
	}
	var mu sync.Mutex
	var g errgroup.Group
	g.SetLimit(feedFetchers)
	for _, u := range urls {
		g.Go(func() error {
			fctx, cancel := context.WithTimeout(ctx, feedFetchTimeout)
			defer cancel()
			f, err := s.fetchFeed(fctx, u)
			if err != nil {
				slog.DebugContext(ctx, "integrations: feed", "url", linkpreview.LogURL(u), "err", err)
			}
			mu.Lock()
			feeds[u] = f
			mu.Unlock()
			return nil
		})
	}
	_ = g.Wait() // fetches never fail the group
	for _, a := range alerts {
		f := feeds[a.url]
		if f == nil {
			continue
		}
		fresh := newEntries(f.Entries, a.last)
		if len(fresh) == 0 {
			continue
		}
		if _, err := s.db.Exec(ctx, `UPDATE stream_alerts SET last_item = $2 WHERE id = $1`, a.id, fresh[0].ID); err != nil {
			return err
		}
		for i := len(fresh) - 1; i >= 0; i-- {
			if !titleMatches(fresh[i].Title, a.filter) {
				continue
			}
			if _, err := s.poster.PostAs(ctx, idOf(a.channelID), a.name, feedMessage(fresh[i])); err != nil {
				return err
			}
		}
	}
	return nil
}
