package integrations

import (
	"strings"
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
		{"emphasis around spaces", `<b>Note: </b>text`, "**Note\\:** text"},
		{"empty emphasis", `x<b></b>y`, "xy"},
		{"inline", `<b>bold</b> <em>it</em> <code>a*b</code>`, "**bold** *it* `a*b`"},
		{"links", `<a href="https://x.dev/a(b)">x</a> <a href="javascript:alert(1)">bad</a> <a href="/rel">rel</a>`, "[x](https://x.dev/a%28b%29) bad rel"},
		{"entities and escaping", `<p>Tom &amp; Jerry_s #1 @here</p>`, "Tom & Jerry\\_s \\#1 \\@here"},
		{"dropped tags", `<script>alert(1)</script><style>p{}</style><img src="x.png"><p>kept</p>`, "kept"},
		{"pre", "<pre>a  *b*\n c</pre>", "```\na  *b*\n c\n```"},
		{"backticks in code", "<code>a`b</code>", "`aˋb`"},
		{"backticks in pre", "<pre>x ``` y</pre>", "```\nx ˋˋˋ y\n```"},
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
	require.True(t, strings.HasSuffix(cutMarkdown("```\n"+strings.Repeat("x ", 20)+"\n```", 12), "…\n```"), "a cut inside a code fence closes it")
}
