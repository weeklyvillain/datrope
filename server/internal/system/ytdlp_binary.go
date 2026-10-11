package system

import (
	"os"
	"os/exec"
	"path/filepath"
)

// ManagedYtDlp is where in-place updates put yt-dlp (the data volume, so it survives restarts).
func ManagedYtDlp(dataDir string) string { return filepath.Join(dataDir, "bin", "yt-dlp") }

// YtDlpBinary picks the yt-dlp to use. DATROPE_YTDLP (configured) pins it; otherwise an updated
// copy on the data volume wins over the one in the image. path is "" when there is none.
func YtDlpBinary(configured, dataDir string) (path string, pinned bool) {
	if configured != "" {
		p, err := exec.LookPath(configured)
		if err != nil {
			return "", true
		}
		return p, true
	}
	if st, err := os.Stat(ManagedYtDlp(dataDir)); err == nil && st.Mode().IsRegular() {
		return ManagedYtDlp(dataDir), false
	}
	p, err := exec.LookPath("yt-dlp")
	if err != nil {
		return "", false
	}
	return p, false
}
