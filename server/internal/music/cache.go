package music

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// maxCachedDuration is the longest track kept in the cache, in seconds: long
// mixes would push out many songs.
const maxCachedDuration = 20 * 60

// cache keeps links the bot played to the end, as the Ogg Opus it sent, so a
// replay needs neither yt-dlp nor ffmpeg. Files are named by the page URL and
// the least recently played go first when the cache is over its size.
type cache struct {
	dir string
	max int64
	mu  sync.Mutex // one sweep at a time
}

func newCache(dir string, max int64) (*cache, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	parts, _ := filepath.Glob(filepath.Join(dir, "*.part")) // plays that never finished
	for _, p := range parts {
		_ = os.Remove(p)
	}
	c := &cache{dir: dir, max: max}
	c.sweep()
	return c, nil
}

// cacheable: a link of known length, at most maxCachedDuration, and not a live stream.
func cacheable(t *MusicTrack) bool {
	return t.blob == "" && t.URL != "" && !t.live && t.Duration > 0 && t.Duration <= maxCachedDuration
}

func (c *cache) path(pageURL string) string {
	sum := sha256.Sum256([]byte(pageURL))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:])+".ogg")
}

// has reports whether a page is cached.
func (c *cache) has(pageURL string) bool {
	_, err := os.Stat(c.path(pageURL))
	return err == nil
}

// open returns a page's cached file and marks it played now.
func (c *cache) open(pageURL string) (*os.File, bool) {
	p := c.path(pageURL)
	f, err := os.Open(p)
	if err != nil {
		return nil, false
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	return f, true
}

// cacheEntry is a file being written while the track plays: commit keeps it
// (the track played to the end), abort drops it.
type cacheEntry struct {
	c      *cache
	f      *os.File
	final  string
	failed bool
}

func (c *cache) create(pageURL string) *cacheEntry {
	final := c.path(pageURL)
	f, err := os.CreateTemp(c.dir, filepath.Base(final)+".*.part")
	if err != nil {
		return nil
	}
	return &cacheEntry{c: c, f: f, final: final}
}

// Write never fails: a full disk must not stop the music, only the caching.
func (e *cacheEntry) Write(p []byte) (int, error) {
	if !e.failed {
		if _, err := e.f.Write(p); err != nil {
			e.failed = true
		}
	}
	return len(p), nil
}

func (e *cacheEntry) commit() {
	name := e.f.Name()
	if err := e.f.Close(); err != nil || e.failed {
		_ = os.Remove(name)
		return
	}
	if err := os.Rename(name, e.final); err != nil { // e.g. Windows, while another channel reads it
		_ = os.Remove(name)
		return
	}
	e.c.sweep()
}

func (e *cacheEntry) abort() {
	name := e.f.Name()
	_ = e.f.Close()
	_ = os.Remove(name)
}

// sweep removes the least recently played files until the cache fits.
func (c *cache) sweep() {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	var total int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".ogg") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, file{filepath.Join(c.dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	slices.SortFunc(files, func(a, b file) int { return a.mod.Compare(b.mod) })
	for _, f := range files {
		if total <= c.max {
			return
		}
		if os.Remove(f.path) == nil {
			total -= f.size
		}
	}
}
