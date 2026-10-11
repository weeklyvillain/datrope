package integrations_test

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/integrations"
)

// feedServer serves one RSS feed at /feed.xml whose items a test changes.
type feedServer struct {
	mu    sync.Mutex
	title string
	items []string // <item> elements, newest first
	fail  bool
	slow  time.Duration // every request waits this long first
	hits  int
	srv   *httptest.Server
}

func newFeedServer(t *testing.T) *feedServer {
	f := &feedServer{title: "730 RSS Feed"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		slow := f.slow
		f.mu.Unlock()
		time.Sleep(slow)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.hits++
		if f.fail || (r.URL.Path != "/feed.xml" && r.URL.Path != "/slow.xml") {
			http.Error(w, "nope", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		fmt.Fprintf(w, `<?xml version="1.0"?><rss version="2.0"><channel><title>%s</title>%s</channel></rss>`, f.title, strings.Join(f.items, ""))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func feedItem(n int, title string) string {
	return fmt.Sprintf(`<item><title>%s</title><link>https://example.com/news/%d</link><guid>news-%d</guid><description>&lt;p&gt;Notes %d&lt;/p&gt;</description></item>`, title, n, n, n)
}

// push puts items on top of the feed, oldest first.
func (f *feedServer) push(items ...string) {
	f.set(func(f *feedServer) {
		for _, it := range items {
			f.items = append([]string{it}, f.items...)
		}
	})
}

func (f *feedServer) set(fn func(*feedServer)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *feedServer) url() string { return f.srv.URL + "/feed.xml" }

func setupFeeds(t *testing.T) (*apptest.Env, *feedServer, *apptest.Client) {
	f := newFeedServer(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) {
		c.Integrations = integrations.Endpoints{FeedAllow: func(net.IP) bool { return true }} // the fake feed is on loopback
	})
	return env, f, env.Register("alice")
}

func TestFeedAlertCreate(t *testing.T) {
	env, f, alice := setupFeeds(t)
	bob := env.Register("bob")
	alerts := "/api/channels/" + alice.General().String() + "/alerts"
	f.push(feedItem(1, "Counter-Strike 2 Update"))

	bob.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url()}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": "ftp://example.com/feed"}, http.StatusBadRequest, "BAD_ACCOUNT")
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": "example.com/feed"}, http.StatusBadRequest, "BAD_ACCOUNT")
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.srv.URL + "/missing.xml"}, http.StatusBadRequest, "BAD_ACCOUNT")

	var a integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": " " + f.url() + " ", "title_filter": " Update "}, http.StatusCreated, &a)
	require.Equal(t, f.url(), a.Account)
	require.Equal(t, f.url(), a.URL)
	require.Equal(t, "730 RSS Feed", a.DisplayName, "no name given: the feed's title")
	require.Equal(t, "Update", a.TitleFilter)
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url()}, http.StatusConflict, "ALREADY_FOLLOWED")

	var named integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url() + "?v=2", "name": " Counter-Strike 2 "}, http.StatusCreated, &named)
	require.Equal(t, "Counter-Strike 2", named.DisplayName)
	require.Equal(t, "", named.TitleFilter)

	f.set(func(f *feedServer) { f.title = "" })
	var untitled integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url() + "?v=3"}, http.StatusCreated, &untitled)
	require.Equal(t, strings.TrimPrefix(f.srv.URL, "http://"), untitled.DisplayName, "no name, no title: the host")

	var list []integrations.StreamAlert
	alice.Do(http.MethodGet, alerts, nil, http.StatusOK, &list)
	require.Len(t, list, 3)
	require.Equal(t, "rss", list[0].Platform)
	require.Equal(t, "Update", list[0].TitleFilter)
}

func TestFeedAlertRefusesPrivateAddresses(t *testing.T) {
	f := newFeedServer(t)
	f.push(feedItem(1, "Counter-Strike 2 Update"))
	env := apptest.New(t) // production settings: public addresses only
	alice := env.Register("alice")
	alerts := "/api/channels/" + alice.General().String() + "/alerts"
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url()}, http.StatusBadRequest, "BAD_ACCOUNT")
	require.Zero(t, f.hits, "the loopback feed was never reached")
}

func TestFeedAlertPolling(t *testing.T) {
	env, f, alice := setupFeeds(t)
	general := alice.General()
	alerts := "/api/channels/" + general.String() + "/alerts"
	poll := func() { require.NoError(t, integrations.PollAll(t.Context(), env.App.Integrations)) }
	count := func() int { return len(messagesIn(t, alice, general)) }

	f.push(feedItem(1, "Counter-Strike 2 Update"))
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": f.url(), "name": "Counter-Strike 2", "title_filter": "update"}, http.StatusCreated, nil)

	// What was in the feed when it was added is not posted.
	poll()
	require.Zero(t, count())

	// One new entry, posted once.
	f.push(feedItem(2, "Counter-Strike 2 Update"))
	poll()
	ms := messagesIn(t, alice, general)
	require.Len(t, ms, 1)
	require.Nil(t, ms[0].Author)
	require.Equal(t, "Counter-Strike 2", ms[0].Webhook.Name)
	require.Equal(t, "📰 **Counter-Strike 2 Update**\nNotes 2\nhttps://example.com/news/2", ms[0].Content)
	poll()
	require.Equal(t, 1, count(), "each entry once")

	// The filter (any case) skips "Rush Hour"; the rest are posted oldest first.
	f.push(feedItem(3, "Rush Hour"), feedItem(4, "Counter-Strike 2 Update"), feedItem(5, "Counter-Strike 2 Update"))
	poll()
	ms = messagesIn(t, alice, general)
	require.Len(t, ms, 3)
	require.Contains(t, ms[0].Content, "news/5")
	require.Contains(t, ms[1].Content, "news/4")
	poll()
	require.Equal(t, 3, count(), "a skipped entry stays skipped")

	// Seven new entries: only the five newest.
	for n := 6; n <= 12; n++ {
		f.push(feedItem(n, "Counter-Strike 2 Update"))
	}
	poll()
	ms = messagesIn(t, alice, general)
	require.Len(t, ms, 8)
	require.Contains(t, ms[0].Content, "news/12")
	require.Contains(t, ms[4].Content, "news/8")

	// The feed rewrote its IDs, so the last one seen is gone: only the newest is posted.
	f.set(func(f *feedServer) {
		f.items = []string{feedItem(101, "Counter-Strike 2 Update"), feedItem(100, "Counter-Strike 2 Update")}
	})
	poll()
	ms = messagesIn(t, alice, general)
	require.Len(t, ms, 9)
	require.Contains(t, ms[0].Content, "news/101")

	// A failing feed posts nothing; its entries come once it is back.
	f.set(func(f *feedServer) { f.fail = true })
	f.push(feedItem(102, "Counter-Strike 2 Update"))
	poll()
	require.Equal(t, 9, count())
	f.set(func(f *feedServer) { f.fail = false })
	poll()
	ms = messagesIn(t, alice, general)
	require.Len(t, ms, 10)
	require.Contains(t, ms[0].Content, "news/102")
}

func TestFeedAlertFetchesEachFeedOnce(t *testing.T) {
	env, f, alice := setupFeeds(t)
	general := alice.General()
	news := alice.CreateTextChannel("news")
	f.push(feedItem(1, "Counter-Strike 2 Update"))
	for _, ch := range []string{general.String(), news.String()} {
		alice.Do(http.MethodPost, "/api/channels/"+ch+"/alerts", map[string]any{"platform": "rss", "account": f.url()}, http.StatusCreated, nil)
	}
	f.push(feedItem(2, "Counter-Strike 2 Update"))
	f.set(func(f *feedServer) { f.hits = 0 })
	require.NoError(t, integrations.PollAll(t.Context(), env.App.Integrations))
	require.Equal(t, 1, f.hits)
	require.Len(t, messagesIn(t, alice, general), 1)
	require.Len(t, messagesIn(t, alice, news), 1)
}

func TestFeedPollSlowFeedsDoNotStallOthers(t *testing.T) {
	env, fast, alice := setupFeeds(t)
	slow := newFeedServer(t)
	slow.set(func(f *feedServer) { f.slow = 2 * time.Second })
	general := alice.General()
	alerts := "/api/channels/" + general.String() + "/alerts"
	urls := []string{slow.srv.URL + "/slow.xml?a", slow.srv.URL + "/slow.xml?b", fast.url()}

	fast.push(feedItem(1, "Old"))
	slow.push(feedItem(1, "Old"))
	for _, u := range urls {
		alice.Do(http.MethodPost, alerts, map[string]any{"platform": "rss", "account": u, "name": u}, http.StatusCreated, nil)
	}
	fast.push(feedItem(2, "New"))
	slow.push(feedItem(2, "New"))

	start := time.Now()
	require.NoError(t, integrations.PollAll(t.Context(), env.App.Integrations))
	require.Less(t, time.Since(start), 3500*time.Millisecond, "the slow feeds are fetched side by side")
	require.Len(t, messagesIn(t, alice, general), 3, "every alert posted")
}
