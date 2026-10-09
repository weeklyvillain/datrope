package linkpreview

import (
	"io"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

const (
	maxTitle = 200
	maxDesc  = 300
	maxSite  = 100
)

// Parse reads a page's <head> for OpenGraph tags and the title.
func Parse(r io.Reader, pageURL *url.URL) (*Preview, bool) {
	z := html.NewTokenizer(r)
	meta := map[string]string{}
	var title strings.Builder
	inTitle := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			return finish(meta, title.String(), pageURL)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "title":
				inTitle = true
			case "body":
				return finish(meta, title.String(), pageURL)
			case "meta":
				var key, content string
				for hasAttr {
					var k, v []byte
					k, v, hasAttr = z.TagAttr()
					switch string(k) {
					case "property", "name":
						key = strings.ToLower(string(v))
					case "content":
						content = string(v)
					}
				}
				if key != "" && meta[key] == "" {
					meta[key] = content
				}
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "title":
				inTitle = false
			case "head":
				return finish(meta, title.String(), pageURL)
			}
		case html.TextToken:
			if inTitle {
				title.Write(z.Text())
			}
		}
	}
}

func finish(meta map[string]string, title string, pageURL *url.URL) (*Preview, bool) {
	p := &Preview{URL: pageURL.String()}
	p.Title = clean(firstNonEmpty(meta["og:title"], meta["twitter:title"], title), maxTitle)
	if p.Title == "" {
		return nil, false
	}
	p.Description = clean(firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"]), maxDesc)
	p.Site = clean(firstNonEmpty(meta["og:site_name"], pageURL.Hostname()), maxSite)
	return p, true
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// clean makes s valid UTF-8 without NULs (Postgres rejects both), collapses
// whitespace and cuts to n runes.
func clean(s string, n int) string {
	s = strings.ReplaceAll(strings.ToValidUTF8(s, "\uFFFD"), "\x00", "")
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	return s
}
