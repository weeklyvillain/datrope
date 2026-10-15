package system

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/music"
)

// ErrPinned: DATROPE_YTDLP names the binary, so the dashboard does not replace it.
var ErrPinned = errors.New("yt-dlp is pinned by DATROPE_YTDLP")

const maxYtDlpBytes = 64 << 20

type YtDlpOptions struct {
	Path    *music.YtDlpPath
	Managed string
	Pinned  bool
	API     string
	Client  *http.Client
	Version func(ctx context.Context, path string) (string, error)
}

type YtDlpStatus struct {
	Available bool       `json:"available" doc:"The server has a yt-dlp binary"`
	Installed string     `json:"installed"`
	Latest    string     `json:"latest"`
	CheckedAt *time.Time `json:"checked_at,omitempty"`
	Pinned    bool       `json:"pinned" doc:"DATROPE_YTDLP names the binary; it is not updated here"`
	Error     string     `json:"error,omitempty" doc:"The last check or update failure"`
}

// YtDlp checks GitHub for yt-dlp releases and installs them on the data volume.
type YtDlp struct {
	opts     YtDlpOptions
	active   func() bool // nil: always; the standby update slot skips the daily check
	updating sync.Mutex  // one update at a time

	mu        sync.Mutex
	installed string
	latest    string
	checkedAt *time.Time
	err       string
}

type ghRelease struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r ghRelease) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func NewYtDlp(o YtDlpOptions) *YtDlp {
	if o.API == "" {
		o.API = "https://api.github.com"
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: 60 * time.Second}
	}
	if o.Version == nil {
		o.Version = runVersion
	}
	if o.Path == nil {
		o.Path = music.NewYtDlpPath("")
	}
	return &YtDlp{opts: o}
}

func runVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	return strings.TrimSpace(string(out)), err
}

func (y *YtDlp) Status() YtDlpStatus {
	y.mu.Lock()
	defer y.mu.Unlock()
	return YtDlpStatus{
		Available: y.opts.Path.Get() != "", Installed: y.installed, Latest: y.latest,
		CheckedAt: y.checkedAt, Pinned: y.opts.Pinned, Error: y.err,
	}
}

// setErr records err (or clears the last one) for Status and returns it.
func (y *YtDlp) setErr(err error) error {
	y.mu.Lock()
	y.err = ""
	if err != nil {
		y.err = err.Error()
	}
	y.mu.Unlock()
	return err
}

// Check reads the installed version and the latest release.
func (y *YtDlp) Check(ctx context.Context) error {
	var installed string
	if p := y.opts.Path.Get(); p != "" {
		v, err := y.opts.Version(ctx, p)
		if err != nil {
			return y.setErr(fmt.Errorf("yt-dlp --version: %w", err))
		}
		installed = v
	}
	rel, err := y.release(ctx)
	if err != nil {
		return y.setErr(err)
	}
	now := time.Now()
	y.mu.Lock()
	y.installed, y.latest, y.checkedAt = installed, rel.Tag, &now
	y.mu.Unlock()
	return y.setErr(nil)
}

// Update installs the latest release. Any failure leaves the current binary in use.
func (y *YtDlp) Update(ctx context.Context) error {
	if y.opts.Pinned {
		return ErrPinned
	}
	y.updating.Lock()
	defer y.updating.Unlock()
	return y.setErr(y.update(ctx))
}

func (y *YtDlp) update(ctx context.Context) error {
	rel, err := y.release(ctx)
	if err != nil {
		return err
	}
	binURL, sumsURL := rel.asset("yt-dlp"), rel.asset("SHA2-256SUMS")
	if binURL == "" || sumsURL == "" {
		return fmt.Errorf("yt-dlp %s: the release has no yt-dlp or SHA2-256SUMS asset", rel.Tag)
	}
	sums, err := y.get(ctx, sumsURL, 1<<20)
	if err != nil {
		return err
	}
	want := checksumFor(sums, "yt-dlp")
	if want == "" {
		return errors.New("yt-dlp: SHA2-256SUMS does not list yt-dlp")
	}
	bin, err := y.get(ctx, binURL, maxYtDlpBytes)
	if err != nil {
		return err
	}
	got := sha256.Sum256(bin)
	if hex.EncodeToString(got[:]) != want {
		return errors.New("yt-dlp: checksum mismatch, download discarded")
	}
	if err := os.MkdirAll(filepath.Dir(y.opts.Managed), 0o755); err != nil {
		return err
	}
	tmp := y.opts.Managed + ".tmp"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return err
	}
	v, err := y.opts.Version(ctx, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("yt-dlp: the new binary does not run: %w", err)
	}
	if err := os.Rename(tmp, y.opts.Managed); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	y.opts.Path.Set(y.opts.Managed)
	now := time.Now()
	y.mu.Lock()
	y.installed, y.latest, y.checkedAt = v, rel.Tag, &now
	y.mu.Unlock()
	slog.Info("yt-dlp updated", "version", v)
	return nil
}

func (y *YtDlp) release(ctx context.Context) (ghRelease, error) {
	var rel ghRelease
	b, err := y.get(ctx, y.opts.API+"/repos/yt-dlp/yt-dlp/releases/latest", 1<<20)
	if err != nil {
		return rel, err
	}
	if err := json.Unmarshal(b, &rel); err != nil {
		return rel, fmt.Errorf("yt-dlp: release: %w", err)
	}
	if rel.Tag == "" {
		return rel, errors.New("yt-dlp: the release has no tag")
	}
	return rel, nil
}

func (y *YtDlp) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := y.opts.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("yt-dlp: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("yt-dlp: GET %s: %s", url, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("yt-dlp: %s is larger than %d bytes", url, limit)
	}
	return b, nil
}

// checksumFor finds name in a sha256sum-style file ("<hex>  <name>" or "<hex> *<name>").
func checksumFor(sums []byte, name string) string {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

// RunDaily checks a minute after start (not at once, so tests and restarts stay quiet), then daily.
func (y *YtDlp) RunDaily(ctx context.Context) {
	t := time.NewTimer(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !y.isActive() {
				t.Reset(time.Minute) // both slots share the binary: only the live one updates it
				continue
			}
			if err := y.Check(ctx); err != nil {
				slog.Warn("yt-dlp: update check", "err", err)
			}
			t.Reset(24 * time.Hour)
		}
	}
}
