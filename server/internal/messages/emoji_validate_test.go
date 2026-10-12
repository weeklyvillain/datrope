package messages

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidUnicodeEmoji(t *testing.T) {
	for _, ok := range []string{"👍", "👍🏽", "❤️", "🇸🇪", "1️⃣", "#️⃣", "👩\u200d👩\u200d👧", "🏳️\u200d🌈", "😀", "✅", "☕", "▶️", "⤴️", "◼️"} {
		require.True(t, ValidUnicodeEmoji(ok), ok)
	}
	for _, bad := range []string{"", "a", "ab", "👍 ", " 👍", "1", "👍a", "<script>", "\u200d", "️",
		"😀😀😀😀😀😀😀😀😀😀😀", "custom:1"} {
		require.False(t, ValidUnicodeEmoji(bad), bad)
	}
}

// TestPickerEmojiValid checks every emoji the web picker offers (emojibase,
// groups other than components; no skin tone variants) against ValidUnicodeEmoji.
func TestPickerEmojiValid(t *testing.T) {
	raw, err := os.ReadFile("../../../node_modules/emojibase-data/en/compact.json")
	if err != nil {
		t.Skip("emojibase-data not installed:", err)
	}
	type emoji struct {
		Group   *int   `json:"group"`
		Unicode string `json:"unicode"`
	}
	var list []emoji
	require.NoError(t, json.Unmarshal(raw, &list))
	n := 0
	for _, e := range list {
		if e.Group == nil || *e.Group == 2 {
			continue
		}
		n++
		require.True(t, ValidUnicodeEmoji(e.Unicode), "%q (%U)", e.Unicode, []rune(e.Unicode))
	}
	require.Greater(t, n, 1000)
}
