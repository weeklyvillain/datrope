package messages

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

const keycapBases = "0123456789#*"

// ValidUnicodeEmoji is a structural check (M5 plan decision 3): short, made
// only of emoji code points and their joiners and modifiers, with at least
// one pictograph, flag letter or keycap.
func ValidUnicodeEmoji(s string) bool {
	if s == "" || len(s) > 32 || !utf8.ValidString(s) {
		return false
	}
	runes := []rune(s)
	if len(runes) > 10 {
		return false
	}
	base := false
	for i, r := range runes {
		switch {
		case isPictograph(r), isRegionalIndicator(r):
			base = true
		case r == 0x200D, r == 0xFE0F, r >= 0x1F3FB && r <= 0x1F3FF, r >= 0xE0020 && r <= 0xE007F:
			// ZWJ, VS16, skin tones, tag sequences (subdivision flags)
		case r == 0x20E3: // combining keycap: must follow [0-9#*] FE0F
			if i < 2 || runes[i-1] != 0xFE0F || !strings.ContainsRune(keycapBases, runes[i-2]) {
				return false
			}
			base = true
		case strings.ContainsRune(keycapBases, r):
			if i+2 >= len(runes) || runes[i+1] != 0xFE0F || runes[i+2] != 0x20E3 {
				return false
			}
		default:
			return false
		}
	}
	return base
}

func isRegionalIndicator(r rune) bool { return r >= 0x1F1E6 && r <= 0x1F1FF }

// isPictograph covers the emoji blocks; precise enough for validating reactions.
func isPictograph(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FAFF:
		return !isRegionalIndicator(r) && !(r >= 0x1F3FB && r <= 0x1F3FF)
	case r >= 0x2600 && r <= 0x27BF, r >= 0x2190 && r <= 0x21FF, r >= 0x2300 && r <= 0x23FF, r >= 0x2B00 && r <= 0x2BFF,
		r >= 0x25A0 && r <= 0x25FF, r >= 0x2900 && r <= 0x297F:
		return true
	case r == 0x00A9, r == 0x00AE, r == 0x203C, r == 0x2049, r == 0x2122, r == 0x2139, r == 0x24C2,
		r == 0x3030, r == 0x303D, r == 0x3297, r == 0x3299:
		return true
	}
	return false
}

// customEmojiID parses "custom:<id>".
func customEmojiID(s string) (int64, bool) {
	rest, ok := strings.CutPrefix(s, "custom:")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(rest, 10, 64)
	return n, err == nil && n > 0
}
