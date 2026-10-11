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
	outer := w.b
	w.b = strings.Builder{}
	w.children(n)
	inner := w.b.String()
	w.b = outer
	trimmed := strings.TrimSpace(inner)
	if trimmed == "" {
		if inner != "" && !w.atSpace() {
			w.b.WriteString(" ")
		}
		return
	}
	// Emphasis only renders when the markers touch non-space text.
	if strings.HasPrefix(inner, " ") && !w.atSpace() {
		w.b.WriteString(" ")
	}
	w.b.WriteString(mark + trimmed + mark)
	if strings.HasSuffix(inner, " ") {
		w.b.WriteString(" ")
	}
}

// text writes a text node with its whitespace collapsed, escaped so feed text
// can't format the message.
func (w *mdWriter) text(s string) {
	// Inside code spans and fences a backtick would close the span or fence early
	// and let the rest of the entry render as Markdown, so it becomes a look-alike.
	if w.pre {
		w.b.WriteString(strings.ReplaceAll(s, "`", "\u02cb"))
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
	if w.code {
		t = strings.ReplaceAll(t, "`", "\u02cb")
	} else {
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
	cut = strings.TrimRight(cut, " \n\\") + "…"
	fences := 0
	for _, l := range strings.Split(cut, "\n") {
		if l == "```" {
			fences++
		}
	}
	if fences%2 == 1 {
		cut += "\n```"
	}
	return cut
}
