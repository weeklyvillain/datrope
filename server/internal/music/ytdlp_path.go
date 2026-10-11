package music

import "sync/atomic"

// YtDlpPath is the yt-dlp binary in use. The system dashboard swaps it after an update;
// the next yt-dlp call uses the new one and running calls finish on the old.
type YtDlpPath struct{ p atomic.Pointer[string] }

func NewYtDlpPath(path string) *YtDlpPath {
	y := &YtDlpPath{}
	y.Set(path)
	return y
}

func (y *YtDlpPath) Get() string { return *y.p.Load() }

func (y *YtDlpPath) Set(path string) { y.p.Store(&path) }
