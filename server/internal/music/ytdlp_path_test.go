package music

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYtDlpPathSwap(t *testing.T) {
	p := NewYtDlpPath("/usr/local/bin/yt-dlp")
	y := ytDlp{path: p}
	require.Equal(t, "/usr/local/bin/yt-dlp", y.path.Get())
	p.Set("/data/bin/yt-dlp")
	require.Equal(t, "/data/bin/yt-dlp", y.path.Get(), "the resolver sees a swap on its next call")
}
