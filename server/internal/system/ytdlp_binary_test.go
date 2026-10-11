package system

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYtDlpBinary(t *testing.T) {
	dir := t.TempDir()
	_, pinned := YtDlpBinary("", dir)
	require.False(t, pinned)

	require.NoError(t, os.MkdirAll(filepath.Join(dir, "bin"), 0o755))
	require.NoError(t, os.WriteFile(ManagedYtDlp(dir), []byte("x"), 0o755))
	path, pinned := YtDlpBinary("", dir)
	require.Equal(t, ManagedYtDlp(dir), path, "an updated copy wins over the image's")
	require.False(t, pinned)

	_, pinned = YtDlpBinary("/opt/yt-dlp", dir)
	require.True(t, pinned, "DATROPE_YTDLP pins the binary")
}
