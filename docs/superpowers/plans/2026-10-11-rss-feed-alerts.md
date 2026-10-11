# RSS Feed Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A channel can follow any RSS or Atom feed (first use: Counter-Strike 2 patch notes from Steam) and gets a readable message for each new entry, optionally only entries whose title contains a filter.

**Architecture:** Feeds are a third platform, `rss`, of the existing stream alerts in `server/internal/integrations`: same table, handlers, permissions and settings tab. New files `feedhtml.go` (HTML → Markdown) and `feeds.go` (parse, fetch, poll) sit next to `youtube.go`. Feed URLs are fetched with the `linkpreview` client that refuses private addresses.

**Tech Stack:** Go (huma, pgx, `encoding/xml`, `golang.org/x/net/html`, `golang.org/x/net/html/charset`), Postgres (goose migrations), React 18 + shadcn/ui, openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-10-11-rss-feed-alerts-design.md`

**Deviations from the spec (decided while planning):**
- Feeds poll on every 20th tick of the existing 30 s loop (`tick%20 == 0`, 10 minutes), like YouTube's `tick%10`, instead of keeping their own last-run time. Same interval, less code.
- No Playwright test: there is no stream-alerts e2e test to extend, and the e2e stack can't serve a feed on a public address (the SSRF guard refuses loopback). The web change is checked with typecheck, lint and a browser check in Task 5.
- Tests reach a feed on `127.0.0.1` through a new `Endpoints.FeedAllow` hook (nil in production = public addresses only).

## Global Constraints

- Never commit. "Stage" steps run `git add` only; the user commits. Git here needs `-c safe.directory='*'`.
- Run Go from PowerShell with `$env:GOTOOLCHAIN='local'` (Git Bash breaks testcontainers). Docker must be running for `apptest`.
- Body cut: at most **1500** characters, at a line or word break, then `…`.
- At most **5** new entries posted per alert per round; feed responses capped at **2 MB**.
- Feed check interval: **10 minutes**.
- `name` and `title_filter`: optional, max **100** characters each, ignored for other platforms.
- Message format: `📰 **<title>**`, newline, body Markdown (if any), newline, link (http/https only).
- Feed URLs must be absolute `http`/`https`; errors are `BAD_ACCOUNT` with "use a feed URL starting with https://" or "that URL is not an RSS or Atom feed".
- Web: shadcn components and token classes only, no hardcoded colors, no `dark:` variants; keep existing accessible names.

## Review Focus

1. **Steam pre-escapes its text** (`\[ MISC ]`): the message must read `[ MISC ]`, not `\[ MISC ]`. → Task 1, `steam patch notes` case.
2. **A feed rewrites its entry IDs** (last seen ID vanishes): post only the newest entry, never flood the channel. → Task 4, "rewrote its IDs" step.
3. **A feed URL on a private or loopback address**: refused on create, nothing fetched. → Task 3, `TestFeedAlertRefusesPrivateAddresses`.
4. **A non-UTF-8 feed or one using HTML entities like `&nbsp;`**: still parses. → Task 2, ISO-8859-1 case.
5. **A feed that is down for a round**: nothing posted, `last_item` unchanged, entries posted once it is back. → Task 4, "failing feed" step.

## File Structure

- Create `server/internal/integrations/feedhtml.go`: `feedMarkdown`, `cutMarkdown`, `linkOf`. Pure functions, no I/O.
- Create `server/internal/integrations/feedhtml_test.go` (package `integrations`).
- Create `server/internal/integrations/feeds.go`: feed types, `parseFeed`, `feedMessage` (Task 2); `fetchFeed`, `feedURLOf`, `feedName` (Task 3); `newEntries`, `titleMatches`, `pollFeeds` (Task 4).
- Create `server/internal/integrations/feeds_test.go` (package `integrations`) and `testdata/steam.xml`, `testdata/atom.xml`.
- Create `server/internal/integrations/feed_alerts_test.go` (package `integrations_test`): API and polling tests.
- Create `server/internal/db/migrations/00036_feed_alerts.sql`.
- Modify `server/internal/integrations/integrations.go`: `Endpoints.FeedAllow`, `Service.feeds`, `Poll`.
- Modify `server/internal/integrations/alerts.go`: types, `alertURL`, `listAlerts`, create handler.
- Modify `server/internal/integrations/export_test.go`: `PollAll` includes feeds.
- Modify `clients/core/openapi.json`, `clients/core/src/schema.d.ts` (generated).
- Modify `clients/web/src/app/dialogs/AlertsTab.tsx`.

---

### Task 1: HTML → Markdown for feed entries

**Files:**
- Create: `server/internal/integrations/feedhtml.go`
- Test: `server/internal/integrations/feedhtml_test.go`

**Interfaces:**
- Consumes: `escapeMarkdown(s string) string` and `markdownSpecial` from `alerts.go`.
- Produces: `feedMarkdown(src string) string`, `cutMarkdown(s string, n int) string`, `linkOf(raw string) string` (absolute http(s) URL with `(`/`)` percent-encoded, else `""`), `const maxFeedBody = 1500`.

- [ ] **Step 1: Write the failing tests**

```go
package integrations

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFeedMarkdown(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"steam patch notes",
			`<p class="bb_paragraph">\[ MISC ]</p><ul class="bb_ul"><li><p class="bb_paragraph">Added a ping icon</p></li><li><p class="bb_paragraph">Fixed *sounds*</p></li></ul>`,
			"\\[ MISC \\]\n\n- Added a ping icon\n- Fixed \\*sounds\\*"},
		{"paragraphs and breaks", `<p>One<br>two</p><p>Three</p>`, "One\ntwo\n\nThree"},
		{"heading", `<h2>Maps</h2><p>Dust</p>`, "**Maps**\n\nDust"},
		{"ordered and nested lists", `<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>`, "1. a\n  - b\n2. c"},
		{"inline", `<b>bold</b> <em>it</em> <code>a*b</code>`, "**bold** *it* `a*b`"},
		{"links", `<a href="https://x.dev/a(b)">x</a> <a href="javascript:alert(1)">bad</a> <a href="/rel">rel</a>`, "[x](https://x.dev/a%28b%29) bad rel"},
		{"entities and escaping", `<p>Tom &amp; Jerry_s #1 @here</p>`, "Tom & Jerry\\_s \\#1 \\@here"},
		{"dropped tags", `<script>alert(1)</script><style>p{}</style><img src="x.png"><p>kept</p>`, "kept"},
		{"pre", "<pre>a  *b*\n c</pre>", "```\na  *b*\n c\n```"},
		{"plain text", "just text", "just text"},
		{"empty", "", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, feedMarkdown(c.in))
		})
	}
}

func TestCutMarkdown(t *testing.T) {
	require.Equal(t, "short", cutMarkdown("short", 10))
	require.Equal(t, "one two…", cutMarkdown("one two three", 9), "at a word break")
	require.Equal(t, "line one…", cutMarkdown("line one\nline two", 12), "at a line break")
	require.Equal(t, "abcdefgh…", cutMarkdown("abcdefghijkl", 8), "no break near the end")
	require.Equal(t, "åäöåäö…", cutMarkdown("åäöåäöåäö", 6), "counts characters, not bytes")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestFeedMarkdown|TestCutMarkdown'`
Expected: build failure, `undefined: feedMarkdown`.

- [ ] **Step 3: Write the implementation**

`server/internal/integrations/feedhtml.go`:

```go
package integrations

import (
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// maxFeedBody is how much of an entry's text a message carries, in characters.
const maxFeedBody = 1500

// feedMarkdown turns an entry's HTML into the Markdown messages use:
// paragraphs, line breaks, headings (as bold lines), lists, bold, italics,
// code and http(s) links. Scripts, styles and images are dropped; any other
// tag keeps only its text.
func feedMarkdown(src string) string {
	doc, err := html.Parse(strings.NewReader(src))
	if err != nil {
		return ""
	}
	w := &mdWriter{}
	w.children(doc)
	return tidyMarkdown(w.b.String())
}

type mdWriter struct {
	b      strings.Builder
	lists  []int // per open list: 0 for <ul>, else the next <ol> number
	inItem int   // open <li> elements
	pre    bool
	code   bool
}

func (w *mdWriter) children(n *html.Node) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		w.node(c)
	}
}

func (w *mdWriter) node(n *html.Node) {
	if n.Type == html.TextNode {
		w.text(n.Data)
		return
	}
	if n.Type != html.ElementNode {
		w.children(n)
		return
	}
	switch n.Data {
	case "script", "style", "img", "iframe", "noscript", "svg", "head":
	case "br":
		w.b.WriteString("\n")
	case "p", "div", "blockquote", "section", "article", "table", "tr":
		if w.inItem > 0 { // Steam wraps every list item's text in a <p>
			w.children(n)
			return
		}
		w.b.WriteString("\n\n")
		w.children(n)
		w.b.WriteString("\n\n")
	case "h1", "h2", "h3", "h4", "h5", "h6":
		w.b.WriteString("\n\n**")
		w.children(n)
		w.b.WriteString("**\n\n")
	case "b", "strong":
		w.wrap(n, "**")
	case "i", "em":
		w.wrap(n, "*")
	case "code":
		if w.pre {
			w.children(n)
			return
		}
		w.code = true
		w.wrap(n, "`")
		w.code = false
	case "pre":
		w.pre = true
		w.b.WriteString("\n\n```\n")
		w.children(n)
		w.b.WriteString("\n```\n\n")
		w.pre = false
	case "ul", "ol":
		next := 0
		if n.Data == "ol" {
			next = 1
		}
		w.lists = append(w.lists, next)
		nested := w.inItem > 0
		if !nested {
			w.b.WriteString("\n\n")
		}
		w.children(n)
		w.lists = w.lists[:len(w.lists)-1]
		if !nested {
			w.b.WriteString("\n\n")
		}
	case "li":
		w.b.WriteString("\n" + strings.Repeat("  ", max(len(w.lists)-1, 0)))
		if k := len(w.lists) - 1; k >= 0 && w.lists[k] > 0 {
			w.b.WriteString(strconv.Itoa(w.lists[k]) + ". ")
			w.lists[k]++
		} else {
			w.b.WriteString("- ")
		}
		w.inItem++
		w.children(n)
		w.inItem--
	case "a":
		href := linkOf(attr(n, "href"))
		if href == "" {
			w.children(n)
			return
		}
		w.b.WriteString("[")
		w.children(n)
		w.b.WriteString("](" + href + ")")
	default:
		w.children(n)
	}
}

func (w *mdWriter) wrap(n *html.Node, mark string) {
	w.b.WriteString(mark)
	w.children(n)
	w.b.WriteString(mark)
}

// text writes a text node with its whitespace collapsed, escaped so feed text
// can't format the message.
func (w *mdWriter) text(s string) {
	if w.pre {
		w.b.WriteString(s)
		return
	}
	words := strings.Fields(s)
	if len(words) == 0 {
		if !w.atSpace() {
			w.b.WriteString(" ")
		}
		return
	}
	if strings.TrimLeft(s, " \t\r\n") != s && !w.atSpace() {
		w.b.WriteString(" ")
	}
	t := strings.Join(words, " ")
	if !w.code {
		t = escapeMarkdown(dropEscapes(t))
	}
	w.b.WriteString(t)
	if strings.TrimRight(s, " \t\r\n") != s {
		w.b.WriteString(" ")
	}
}

// atSpace reports whether the output is empty or ends in a space or newline.
func (w *mdWriter) atSpace() bool {
	s := w.b.String()
	return s == "" || s[len(s)-1] == ' ' || s[len(s)-1] == '\n'
}

// dropEscapes removes backslashes a feed already put before Markdown
// characters (Steam writes "\[ MISC ]"), so escaping them again doesn't
// show them.
func dropEscapes(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && s[i+1] != '\\' && strings.IndexByte(markdownSpecial, s[i+1]) >= 0 {
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// linkOf returns raw if it is an absolute http(s) URL, made safe to sit in a
// Markdown link; anything else (javascript:, relative paths) gives "".
func linkOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.NewReplacer("(", "%28", ")", "%29").Replace(u.String())
}

// tidyMarkdown trims trailing spaces and collapses runs of blank lines to one.
func tidyMarkdown(s string) string {
	var out []string
	blank := false
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimRight(l, " \t")
		if strings.TrimSpace(l) == "" {
			blank = len(out) > 0
			continue
		}
		if blank {
			out = append(out, "")
			blank = false
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// cutMarkdown shortens s to at most n characters, at a line or word break
// when one is in the second half, and marks the cut with "…".
func cutMarkdown(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	cut := string([]rune(s)[:n])
	if i := strings.LastIndex(cut, "\n"); i > len(cut)/2 {
		cut = cut[:i]
	} else if i := strings.LastIndex(cut, " "); i > len(cut)/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " \n\\") + "…"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestFeedMarkdown|TestCutMarkdown'`
Expected: PASS. If a case fails on whitespace only, fix the writer, not the expected string: the expected strings are the contract.

- [ ] **Step 5: Stage**

```bash
git -c safe.directory='*' add server/internal/integrations/feedhtml.go server/internal/integrations/feedhtml_test.go
```

---
### Task 2: Parse RSS and Atom, build the message

**Files:**
- Create: `server/internal/integrations/feeds.go`
- Create: `server/internal/integrations/testdata/steam.xml`, `server/internal/integrations/testdata/atom.xml`
- Test: `server/internal/integrations/feeds_test.go`

**Interfaces:**
- Consumes: `feedMarkdown`, `cutMarkdown`, `linkOf`, `maxFeedBody` (Task 1); `escapeMarkdown` (`alerts.go`).
- Produces: `type feed struct { Title string; Entries []feedEntry }` (entries newest first), `type feedEntry struct { ID, Title, Link, Body string }`, `parseFeed(r io.Reader) (*feed, error)`, `errNotFeed`, `feedMessage(e feedEntry) string`.

- [ ] **Step 1: Add the fixtures**

`server/internal/integrations/testdata/steam.xml` (shape copied from the real `https://store.steampowered.com/feeds/news/app/730`; the third item has no `<guid>` on purpose):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link href="https://store.steampowered.com/news/app/730/" rel="self" type="application/rss+xml" />
    <title>730 RSS Feed</title>
    <link><![CDATA[https://store.steampowered.com/news/app/730/]]></link>
    <description><![CDATA[Events and Announcements for 730]]></description>
    <item>
      <title>Counter-Strike 2 Update</title>
      <description>&lt;p class=&quot;bb_paragraph&quot;&gt;\[ MISC ]&lt;/p&gt;&lt;ul class=&quot;bb_ul&quot;&gt;&lt;li&gt;&lt;p class=&quot;bb_paragraph&quot;&gt;Added a ping icon for dropped defuse kits&lt;/p&gt;&lt;/li&gt;&lt;/ul&gt;</description>
      <link><![CDATA[https://store.steampowered.com/news/app/730/view/3]]></link>
      <pubDate>Thu, 08 Oct 2026 22:36:49 +0000</pubDate>
      <guid isPermaLink="true">https://store.steampowered.com/news/app/730/view/3</guid>
    </item>
    <item>
      <title>Rush Hour</title>
      <description>&lt;p&gt;A new event.&lt;/p&gt;</description>
      <link><![CDATA[https://store.steampowered.com/news/app/730/view/2]]></link>
      <guid isPermaLink="true">https://store.steampowered.com/news/app/730/view/2</guid>
    </item>
    <item>
      <title>Counter-Strike 2 Update</title>
      <description>&lt;p&gt;Stability updates&lt;/p&gt;</description>
      <link><![CDATA[https://store.steampowered.com/news/app/730/view/1]]></link>
    </item>
  </channel>
</rss>
```

`server/internal/integrations/testdata/atom.xml` (first entry: a `rel="self"` link before the page link, and content; second: summary only):

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  <entry>
    <title type="html">Two &amp;amp; more</title>
    <id>tag:example.com,2026:2</id>
    <link rel="self" href="https://example.com/api/posts/2"/>
    <link href="https://example.com/posts/2"/>
    <content type="html">&lt;p&gt;Second post&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>One</title>
    <id>tag:example.com,2026:1</id>
    <link rel="alternate" href="https://example.com/posts/1"/>
    <summary type="html">Older &lt;b&gt;summary&lt;/b&gt;</summary>
  </entry>
</feed>
```

- [ ] **Step 2: Write the failing tests**

`server/internal/integrations/feeds_test.go`:

```go
package integrations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func parseTestdata(t *testing.T, name string) *feed {
	t.Helper()
	r, err := os.Open(filepath.Join("testdata", name))
	require.NoError(t, err)
	defer r.Close()
	f, err := parseFeed(r)
	require.NoError(t, err)
	return f
}

func TestParseFeed(t *testing.T) {
	steam := parseTestdata(t, "steam.xml")
	require.Equal(t, "730 RSS Feed", steam.Title)
	require.Len(t, steam.Entries, 3)
	require.Equal(t, feedEntry{
		ID:    "https://store.steampowered.com/news/app/730/view/3",
		Title: "Counter-Strike 2 Update",
		Link:  "https://store.steampowered.com/news/app/730/view/3",
		Body:  `<p class="bb_paragraph">\[ MISC ]</p><ul class="bb_ul"><li><p class="bb_paragraph">Added a ping icon for dropped defuse kits</p></li></ul>`,
	}, steam.Entries[0])
	require.Equal(t, "Rush Hour", steam.Entries[1].Title)
	require.Equal(t, "https://store.steampowered.com/news/app/730/view/1", steam.Entries[2].ID, "no <guid>: the link identifies it")

	atom := parseTestdata(t, "atom.xml")
	require.Equal(t, "Example Blog", atom.Title)
	require.Equal(t, feedEntry{ID: "tag:example.com,2026:2", Title: "Two &amp; more", Link: "https://example.com/posts/2", Body: "<p>Second post</p>"}, atom.Entries[0])
	require.Equal(t, "https://example.com/posts/1", atom.Entries[1].Link)
	require.Equal(t, "Older <b>summary</b>", atom.Entries[1].Body, "no content: the summary")

	// Not UTF-8, and an HTML entity XML doesn't define.
	latin, err := parseFeed(strings.NewReader("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss><channel><title>Caf\xe9&nbsp;news</title></channel></rss>"))
	require.NoError(t, err)
	require.Equal(t, "Caf\u00e9\u00a0news", latin.Title)

	_, err = parseFeed(strings.NewReader("<html><body>nope</body></html>"))
	require.ErrorIs(t, err, errNotFeed)
	_, err = parseFeed(strings.NewReader("not xml"))
	require.ErrorIs(t, err, errNotFeed)
}

func TestFeedMessage(t *testing.T) {
	steam := parseTestdata(t, "steam.xml")
	require.Equal(t, "📰 **Counter-Strike 2 Update**\n\\[ MISC \\]\n\n- Added a ping icon for dropped defuse kits\nhttps://store.steampowered.com/news/app/730/view/3",
		feedMessage(steam.Entries[0]))

	atom := parseTestdata(t, "atom.xml")
	require.Equal(t, "📰 **Two & more**\nSecond post\nhttps://example.com/posts/2", feedMessage(atom.Entries[0]))

	long := feedMessage(feedEntry{Title: "Big *patch*", Link: "javascript:alert(1)", Body: "<p>" + strings.Repeat("word ", 400) + "</p>"})
	require.True(t, strings.HasPrefix(long, "📰 **Big \\*patch\\***\nword word"), long)
	require.True(t, strings.HasSuffix(long, "word…"), "cut, and the javascript: link dropped")
	require.LessOrEqual(t, utf8.RuneCountInString(long), maxFeedBody+30)

	require.Equal(t, "📰 **New post**\nhttps://example.com/x", feedMessage(feedEntry{Link: "https://example.com/x"}))
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestParseFeed|TestFeedMessage'`
Expected: build failure, `undefined: parseFeed`.

- [ ] **Step 4: Write the implementation**

`server/internal/integrations/feeds.go`:

```go
package integrations

import (
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"strings"

	"golang.org/x/net/html/charset"
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
	parts := []string{"📰 **" + escapeMarkdown(title) + "**"}
	if body := cutMarkdown(feedMarkdown(e.Body), maxFeedBody); body != "" {
		parts = append(parts, body)
	}
	if link := linkOf(e.Link); link != "" {
		parts = append(parts, link)
	}
	return strings.Join(parts, "\n")
}
```

- [ ] **Step 5: Run the tests to verify they pass, then tidy modules**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestParseFeed|TestFeedMessage|TestFeedMarkdown|TestCutMarkdown'`
Expected: PASS.
Run: `$env:GOTOOLCHAIN='local'; go -C server mod tidy`
Expected: at most `golang.org/x/text` loses its `// indirect` mark in `server/go.mod`; nothing else changes.

- [ ] **Step 6: Stage**

```bash
git -c safe.directory='*' add server/internal/integrations/feeds.go server/internal/integrations/feeds_test.go server/internal/integrations/testdata server/go.mod server/go.sum
```

---
### Task 3: Migration, fetching and the create/list API

**Files:**
- Create: `server/internal/db/migrations/00036_feed_alerts.sql`
- Modify: `server/internal/integrations/integrations.go` (imports, `Endpoints`, `Service`, `NewService`)
- Modify: `server/internal/integrations/alerts.go` (`StreamAlert`, `CreateAlertRequest`, `alertURL`, `listAlerts`, create handler)
- Modify: `server/internal/integrations/feeds.go` (add `fetchFeed`, `feedURLOf`, `feedName`)
- Test: `server/internal/integrations/feed_alerts_test.go`

**Interfaces:**
- Consumes: `parseFeed`, `feed` (Task 2); `linkpreview.NewClient(allow func(net.IP) bool, timeout time.Duration) *http.Client`, `linkpreview.Public`.
- Produces: `Endpoints.FeedAllow func(net.IP) bool`; `Service.feeds *http.Client`; `(s *Service) fetchFeed(ctx context.Context, rawURL string) (*feed, error)`; `feedURLOf(input string) (string, bool)`; `feedName(given, title, rawURL string) string`; `StreamAlert.TitleFilter` (`json:"title_filter"`); `CreateAlertRequest.Name`, `.TitleFilter`; column `stream_alerts.title_filter`. Test helpers `newFeedServer`, `feedItem`, `(*feedServer).push`, `.set`, `.url`, `setupFeeds`, used again in Task 4.

- [ ] **Step 1: Write the failing tests**

`server/internal/integrations/feed_alerts_test.go`:

```go
package integrations_test

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	hits  int
	srv   *httptest.Server
}

func newFeedServer(t *testing.T) *feedServer {
	f := &feedServer{title: "730 RSS Feed"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.hits++
		if f.fail || r.URL.Path != "/feed.xml" {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestFeedAlert'`
Expected: build failure, `unknown field FeedAllow` / `a.TitleFilter undefined`.

- [ ] **Step 3: Write the migration**

`server/internal/db/migrations/00036_feed_alerts.sql`:

```sql
-- +goose Up
-- A channel can also follow an RSS or Atom feed (game patch notes, blogs):
-- account holds the feed URL, and title_filter keeps only entries whose
-- title contains it.
ALTER TABLE stream_alerts DROP CONSTRAINT stream_alerts_platform_check;
ALTER TABLE stream_alerts ADD CONSTRAINT stream_alerts_platform_check CHECK (platform IN ('twitch', 'youtube', 'rss'));
ALTER TABLE stream_alerts ADD COLUMN title_filter TEXT NOT NULL DEFAULT '';

-- +goose Down
DELETE FROM stream_alerts WHERE platform = 'rss';
ALTER TABLE stream_alerts DROP COLUMN title_filter;
ALTER TABLE stream_alerts DROP CONSTRAINT stream_alerts_platform_check;
ALTER TABLE stream_alerts ADD CONSTRAINT stream_alerts_platform_check CHECK (platform IN ('twitch', 'youtube'));
```

- [ ] **Step 4: Give the service a feed client**

In `server/internal/integrations/integrations.go`, add `"net"` to the standard imports and `"github.com/datrope/datrope/server/internal/linkpreview"` to the project imports.

Replace the `Endpoints` doc comment and struct:

```go
// Endpoints are the services' base URLs, and which addresses feed URLs may
// reach; tests point them at fakes.
type Endpoints struct {
	TwitchAuth  string
	TwitchAPI   string
	YouTube     string
	SpotifyAuth string
	SpotifyAPI  string
	// FeedAllow decides which addresses a feed URL may dial. Nil means
	// public addresses only; tests allow loopback.
	FeedAllow func(net.IP) bool
}
```

In `Service`, after the `http *http.Client` field, add:

```go
	feeds     *http.Client // for feed URLs people supply: refuses private addresses
```

Replace `NewService`:

```go
func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, poster Poster, publicURL string, ep Endpoints) *Service {
	allow := ep.FeedAllow
	if allow == nil {
		allow = linkpreview.Public
	}
	return &Service{
		db: pool, bus: bus, channels: ch, poster: poster, ep: ep.withDefaults(), publicURL: publicURL,
		http:       &http.Client{Timeout: 15 * time.Second},
		feeds:      linkpreview.NewClient(allow, 15*time.Second),
		activities: map[id.ID]Activity{}, states: map[string]oauthState{}, stop: make(chan struct{}),
	}
}
```

- [ ] **Step 5: Add fetching and the URL and name helpers**

Add `"context"`, `"net/http"` and `"net/url"` to the imports of `server/internal/integrations/feeds.go`, then append:

```go
const (
	maxFeedSize = 2 << 20 // bytes read from a feed
	maxFeedName = 100     // characters of a feed's name
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
```

- [ ] **Step 6: Extend the alert API**

In `server/internal/integrations/alerts.go`, replace the two types:

```go
// StreamAlert: a channel follows a Twitch streamer, a YouTube channel or an RSS/Atom feed.
type StreamAlert struct {
	ID          id.ID  `json:"id"`
	ChannelID   id.ID  `json:"channel_id"`
	Platform    string `json:"platform" enum:"twitch,youtube,rss"`
	Account     string `json:"account" doc:"A Twitch login, a YouTube channel ID or a feed URL"`
	DisplayName string `json:"display_name"`
	URL         string `json:"url"`
	TitleFilter string `json:"title_filter" doc:"RSS: only entries whose title contains this are posted (empty: all)"`
}

type CreateAlertRequest struct {
	Platform    string `json:"platform" enum:"twitch,youtube,rss"`
	Account     string `json:"account" minLength:"1" maxLength:"200" doc:"Twitch: a username or channel link. YouTube: a channel link, @handle or channel ID. RSS: the feed URL"`
	Name        string `json:"name,omitempty" maxLength:"100" doc:"RSS: the name messages are posted under (default: the feed's title)"`
	TitleFilter string `json:"title_filter,omitempty" maxLength:"100" doc:"RSS: post only entries whose title contains this, in any case"`
}
```

Replace `alertURL`:

```go
func alertURL(platform, account string) string {
	switch platform {
	case "twitch":
		return "https://www.twitch.tv/" + account
	case "rss":
		return account
	}
	return "https://www.youtube.com/channel/" + account
}
```

In `listAlerts`, select and scan the filter:

```go
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, platform, account, display_name, title_filter FROM stream_alerts WHERE channel_id = $1 ORDER BY id`, channelID)
```
```go
		err := r.Scan(&a.ID, &a.ChannelID, &a.Platform, &a.Account, &a.DisplayName, &a.TitleFilter)
```

In the create handler's `switch in.Body.Platform`, add before `default:`:

```go
			case "rss":
				u, ok := feedURLOf(in.Body.Account)
				if !ok {
					return nil, errBadAccount("use a feed URL starting with https://")
				}
				f, err := s.fetchFeed(ctx, u)
				if err != nil {
					return nil, errBadAccount("that URL is not an RSS or Atom feed")
				}
				a.Account, a.DisplayName = u, feedName(in.Body.Name, f.Title, u)
				a.TitleFilter = strings.TrimSpace(in.Body.TitleFilter)
				if len(f.Entries) > 0 {
					last = f.Entries[0].ID // only entries after now are posted
				}
```

Replace the insert:

```go
			tag, err := s.db.Exec(ctx, `
				INSERT INTO stream_alerts (id, channel_id, platform, account, display_name, created_by, last_item, title_filter)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
				a.ID, ch.ID, a.Platform, a.Account, a.DisplayName, auth.Current(ctx).User.ID, last, a.TitleFilter)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/`
Expected: PASS, including the existing `TestStreamAlerts`: the migration and the new insert must not break Twitch or YouTube.

- [ ] **Step 8: Stage**

```bash
git -c safe.directory='*' add server/internal/db/migrations/00036_feed_alerts.sql server/internal/integrations/integrations.go server/internal/integrations/alerts.go server/internal/integrations/feeds.go server/internal/integrations/feed_alerts_test.go
```

---
### Task 4: Poll feeds and post new entries

**Files:**
- Modify: `server/internal/integrations/feeds.go` (add `newEntries`, `titleMatches`, `pollFeeds`)
- Modify: `server/internal/integrations/integrations.go` (`pollEvery` comment, `Poll`)
- Modify: `server/internal/integrations/export_test.go` (`PollAll`)
- Test: `server/internal/integrations/feed_alerts_test.go` (append)

**Interfaces:**
- Consumes: `fetchFeed`, `feedMessage`, `feedEntry` (Tasks 2 and 3); `s.poster.PostAs(ctx, channelID id.ID, name, content string)`; `idOf(int64) id.ID`; `linkpreview.LogURL`; the Task 3 test helpers; `messagesIn(t, c, channelID)` from `integrations_test.go` (newest message first); `(*apptest.Client).CreateTextChannel(name string) id.ID`.
- Produces: `(s *Service) pollFeeds(ctx context.Context) error`, `newEntries(entries []feedEntry, last string) []feedEntry`, `titleMatches(title, filter string) bool`, `const maxFeedPosts = 5`.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/integrations/feed_alerts_test.go`:

```go
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
```

- [ ] **Step 2: Include feeds in `PollAll`**

Replace `PollAll` in `server/internal/integrations/export_test.go`:

```go
// PollAll runs every check at once, whatever the tick.
func PollAll(ctx context.Context, s *Service) error {
	return errors.Join(s.pollSpotify(ctx), s.pollTwitch(ctx), s.pollYouTube(ctx), s.pollFeeds(ctx))
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/ -run 'TestFeedAlertPolling|TestFeedAlertFetchesEachFeedOnce'`
Expected: build failure, `s.pollFeeds undefined`.

- [ ] **Step 4: Write the poller**

Add `"log/slog"`, `"github.com/jackc/pgx/v5"` and `"github.com/datrope/datrope/server/internal/linkpreview"` to the imports of `server/internal/integrations/feeds.go`, then append:

```go
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
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, account, display_name, last_item, title_filter FROM stream_alerts WHERE platform = 'rss'`)
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
	feeds := map[string]*feed{} // nil: the fetch failed this round
	for _, a := range alerts {
		f, fetched := feeds[a.url]
		if !fetched {
			if f, err = s.fetchFeed(ctx, a.url); err != nil {
				slog.DebugContext(ctx, "integrations: feed", "url", linkpreview.LogURL(a.url), "err", err)
			}
			feeds[a.url] = f
		}
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
```

- [ ] **Step 5: Run feeds from the poll loop every 10 minutes**

In `server/internal/integrations/integrations.go`, replace the `pollEvery` comment:

```go
// pollEvery is the base tick: Spotify every tick, Twitch every second,
// YouTube every tenth, feeds every twentieth (10 minutes).
```

In `Poll`, after the YouTube check, add:

```go
	if tick%20 == 0 {
		note("feeds", s.pollFeeds(ctx))
	}
```

- [ ] **Step 6: Run the whole package and vet the server**

Run: `$env:GOTOOLCHAIN='local'; rtk go -C server test ./internal/integrations/`
Expected: PASS (all feed tests, `TestStreamAlerts`, `TestSpotifyConnection`).
Run: `$env:GOTOOLCHAIN='local'; rtk go -C server vet ./...`
Expected: no output.

- [ ] **Step 7: Stage**

```bash
git -c safe.directory='*' add server/internal/integrations/feeds.go server/internal/integrations/integrations.go server/internal/integrations/export_test.go server/internal/integrations/feed_alerts_test.go
```

---
### Task 5: RSS feeds in the channel's Alerts tab

**Files:**
- Modify (generated): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/web/src/app/dialogs/AlertsTab.tsx`

**Interfaces:**
- Consumes: `StreamAlert` from `@datrope/core` with `platform: "twitch" | "youtube" | "rss"` and `title_filter: string`; create body `{ platform, account, name?, title_filter? }` (Task 3).
- Produces: UI only.

- [ ] **Step 1: Regenerate the API types**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; rtk pnpm --filter @datrope/core run gen`
Expected: `clients/core/src/schema.d.ts` has `"rss"` in both platform enums, `title_filter` on `StreamAlert`, and optional `name` and `title_filter` on `CreateAlertRequest`. Check with `git -c safe.directory='*' diff --stat clients/core`.

- [ ] **Step 2: Update `AlertsTab.tsx`**

Replace `clients/web/src/app/dialogs/AlertsTab.tsx` with:

```tsx
import { unwrap, type StreamAlert } from "@datrope/core";
import { Rss, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { BrandIcon } from "@/lib/brand-icons";
import { client, useInstanceInfo } from "../../session";

type Platform = StreamAlert["platform"];

const PLACEHOLDER: Record<Platform, string> = {
  twitch: "Username or twitch.tv link",
  youtube: "Channel link, @handle or channel ID",
  rss: "https://store.steampowered.com/feeds/news/app/730",
};

/** Streamers, YouTube channels and feeds this channel follows: a message when they go live, post a video or publish an entry. */
export function AlertsTab({ channelId }: { channelId: string }) {
  const info = useInstanceInfo();
  const [list, setList] = useState<StreamAlert[]>();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  const platformId = useId();
  const accountId = useId();
  const nameId = useId();
  const filterId = useId();
  const { busy, error, run } = useSubmit();
  const path = { params: { path: { id: channelId } } };
  const load = () => run(async () => setList(await unwrap(client.api.GET("/api/channels/{id}/alerts", path)) ?? []));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  return (
    <div className="grid gap-4 pt-2">
      <p className="m-0 text-sm text-muted-foreground">
        A message is posted here when a Twitch streamer goes live, a YouTube channel posts a video or an RSS feed has a new entry. Checks run every few minutes.
      </p>
      <ul className="grid list-none gap-1.5" aria-label="Followed">
        {list?.map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
            {a.platform === "rss"
              ? <Rss className="size-4 flex-none text-muted-foreground" />
              : <BrandIcon slug={a.platform} className="size-4 flex-none text-muted-foreground" />}
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate">{a.display_name}</a>
            {a.title_filter && <span className="flex-none text-xs text-muted-foreground">Title contains “{a.title_filter}”</span>}
            <Button variant="ghost" size="icon-sm" aria-label={`Stop following ${a.display_name}`} disabled={busy}
              onClick={() => void run(async () => {
                await unwrap(client.api.DELETE("/api/channels/{id}/alerts/{alertID}", { params: { path: { id: channelId, alertID: a.id } } }));
                setList((l) => l?.filter((x) => x.id !== a.id));
              })}><Trash2 /></Button>
          </li>
        ))}
        {list?.length === 0 && <li className="text-sm text-muted-foreground">Not following anything yet.</li>}
      </ul>
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const rss = platform === "rss" ? { name: name.trim() || undefined, title_filter: titleFilter.trim() || undefined } : {};
          const a = await unwrap(client.api.POST("/api/channels/{id}/alerts", { ...path, body: { platform, account: account.trim(), ...rss } }));
          setList((l) => [...(l ?? []), a]);
          setAccount("");
          setName("");
          setTitleFilter("");
        });
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-36">
            <FieldLabel htmlFor={platformId}>Platform</FieldLabel>
            <NativeSelect id={platformId} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              <NativeSelectOption value="youtube">YouTube</NativeSelectOption>
              <NativeSelectOption value="twitch" disabled={!info?.twitch_enabled}>Twitch</NativeSelectOption>
              <NativeSelectOption value="rss">RSS feed</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor={accountId}>{platform === "rss" ? "Feed URL" : "Account"}</FieldLabel>
            <Input id={accountId} value={account} maxLength={200} placeholder={PLACEHOLDER[platform]} onChange={(e) => setAccount(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !account.trim()}>Follow</Button>
        </div>
        {platform === "rss" && (
          <div className="flex flex-wrap gap-2">
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input id={nameId} value={name} maxLength={100} placeholder="The feed's title" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor={filterId}>Title contains</FieldLabel>
              <Input id={filterId} value={titleFilter} maxLength={100} placeholder="Every entry" onChange={(e) => setTitleFilter(e.target.value)} />
            </Field>
          </div>
        )}
        {info && !info.twitch_enabled && <span className="text-xs text-muted-foreground">Twitch needs an instance admin to add Twitch credentials under Integrations.</span>}
      </form>
      <ErrorText error={error} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `rtk pnpm --filter @datrope/web run typecheck`
Expected: no errors.
Run: `rtk pnpm lint`
Expected: no new warnings in `AlertsTab.tsx`.

- [ ] **Step 4: Check it in the browser**

Start `datrope-server` and `datrope-web` with `preview_start` (`.claude/launch.json`). In a text channel's settings, open the Alerts tab, choose "RSS feed", enter `https://store.steampowered.com/feeds/news/app/730`, Name `Counter-Strike 2` and Title contains `Update`, then press Follow. Expected: the row shows the RSS icon, "Counter-Strike 2" and `Title contains “Update”`; the Name and Title contains fields disappear when YouTube is chosen. Take a screenshot as proof, then delete the alert. Without the user's dev login, use the throwaway-database approach from the local dev notes.

- [ ] **Step 5: Stage**

```bash
git -c safe.directory='*' add clients/core/openapi.json clients/core/src/schema.d.ts clients/web/src/app/dialogs/AlertsTab.tsx
```
