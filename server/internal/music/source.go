package music

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// Resolved is what a link or a search found.
type Resolved struct {
	Title    string
	URL      string // the page, kept to find a fresh stream when the track plays
	Duration int    // seconds
}

// Resolver finds tracks: yt-dlp, or a fake in tests.
type Resolver interface {
	// Resolve looks up a link, or searches YouTube for any other text.
	Resolve(ctx context.Context, input string) (Resolved, error)
	// Stream returns something ffmpeg can read for a page: a media URL.
	Stream(ctx context.Context, pageURL string) (string, error)
}

// ErrNotFound: nothing matched the link or search.
var ErrNotFound = errors.New("music: nothing found")

type ytDlp struct{ path string }

func (y ytDlp) run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, y.path, append([]string{"--no-playlist", "--no-warnings", "--ignore-config"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("yt-dlp: %w: %s", err, msg)
	}
	return out, nil
}

func (y ytDlp) Resolve(ctx context.Context, input string) (Resolved, error) {
	// --default-search turns plain text into a YouTube search for one result.
	out, err := y.run(ctx, "--default-search", "ytsearch1", "--dump-single-json", "--", input)
	if err != nil {
		return Resolved{}, err
	}
	var info struct {
		Type       string  `json:"_type"`
		Title      string  `json:"title"`
		WebpageURL string  `json:"webpage_url"`
		Duration   float64 `json:"duration"`
		Entries    []struct {
			Title      string  `json:"title"`
			WebpageURL string  `json:"webpage_url"`
			URL        string  `json:"url"`
			Duration   float64 `json:"duration"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return Resolved{}, err
	}
	if info.Type == "playlist" {
		if len(info.Entries) == 0 {
			return Resolved{}, ErrNotFound
		}
		e := info.Entries[0]
		page := e.WebpageURL
		if page == "" {
			page = e.URL
		}
		return Resolved{Title: e.Title, URL: page, Duration: int(e.Duration)}, nil
	}
	if info.WebpageURL == "" {
		return Resolved{}, ErrNotFound
	}
	return Resolved{Title: info.Title, URL: info.WebpageURL, Duration: int(info.Duration)}, nil
}

func (y ytDlp) Stream(ctx context.Context, pageURL string) (string, error) {
	out, err := y.run(ctx, "-f", "bestaudio/best", "--get-url", "--", pageURL)
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if line == "" {
		return "", ErrNotFound
	}
	return line, nil
}

// ffmpegCmd decodes input (a URL, or stdin when input is "") into 48 kHz
// stereo Opus in Ogg pages of 20 ms, on stdout.
func ffmpegCmd(ctx context.Context, path, input string, stdin io.Reader) *exec.Cmd {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	if input == "" {
		args = args[:len(args)-1] // read the file from stdin
		args = append(args, "-i", "pipe:0")
	} else {
		args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", input)
	}
	args = append(args, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20",
		"-application", "audio", "-f", "ogg", "-page_duration", "20000", "pipe:1")
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = stdin
	return cmd
}
