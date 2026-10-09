// Package files owns uploads: content-addressed storage, image processing,
// the attachments table, and the upload/download handlers (spec section 7).
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

var ErrTooLarge = errors.New("file too large")

// Store keeps file contents by SHA-256; identical content is stored once.
// Local disk is the only implementation.
type Store interface {
	// Stage copies r to a temporary file, failing with ErrTooLarge once it
	// exceeds limit bytes.
	Stage(r io.Reader, limit int64) (*Staged, error)
	// Commit moves a staged file into place under its hash. If that content
	// is already stored, the staged copy is simply removed.
	Commit(s *Staged) error
	// Discard removes a staged file that will not be committed. It is safe
	// to call on nil and on a file that was already committed.
	Discard(s *Staged)
	Open(sum string) (io.ReadSeekCloser, error)
	// Remove deletes stored content; missing content is not an error.
	Remove(sum string) error
	// Walk calls fn for every stored file.
	Walk(fn func(sum string, modTime time.Time) error) error
	// RemoveStaleTemp deletes staging files left by crashes.
	RemoveStaleTemp(before time.Time) error
}

// Staged is an uploaded file waiting to be committed.
type Staged struct {
	Sum  string // hex SHA-256 of the contents
	Size int64
	path string
}

func (s *Staged) Open() (*os.File, error) { return os.Open(s.path) }

func (s *Staged) Bytes() ([]byte, error) { return os.ReadFile(s.path) }

// ValidSum reports whether s looks like a hex SHA-256, which is also what
// keeps stored names from escaping the store directory.
func ValidSum(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

type LocalStore struct{ dir string }

// NewLocalStore stores files in dir and stages uploads in dir/tmp (same
// filesystem, so committing is a rename).
func NewLocalStore(dir string) (*LocalStore, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return nil, err
	}
	return &LocalStore{dir: dir}, nil
}

func (l *LocalStore) pathFor(sum string) (string, error) {
	if !ValidSum(sum) {
		return "", fmt.Errorf("invalid content hash %q", sum)
	}
	return filepath.Join(l.dir, sum), nil
}

func (l *LocalStore) Stage(r io.Reader, limit int64) (*Staged, error) {
	f, err := os.CreateTemp(filepath.Join(l.dir, "tmp"), "upload-*")
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, limit+1))
	if err == nil {
		err = f.Sync() // a crash must not leave a hash-named file with partial content
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil && n > limit {
		err = ErrTooLarge
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return nil, err
	}
	return &Staged{Sum: hex.EncodeToString(h.Sum(nil)), Size: n, path: f.Name()}, nil
}

func (l *LocalStore) Commit(s *Staged) error {
	dst, err := l.pathFor(s.Sum)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return os.Remove(s.path)
	}
	return os.Rename(s.path, dst)
}

func (l *LocalStore) Discard(s *Staged) {
	if s != nil {
		_ = os.Remove(s.path)
	}
}

func (l *LocalStore) Open(sum string) (io.ReadSeekCloser, error) {
	p, err := l.pathFor(sum)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (l *LocalStore) Remove(sum string) error {
	p, err := l.pathFor(sum)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (l *LocalStore) Walk(fn func(sum string, modTime time.Time) error) error {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !ValidSum(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // removed meanwhile
		}
		if err := fn(e.Name(), info.ModTime()); err != nil {
			return err
		}
	}
	return nil
}

func (l *LocalStore) RemoveStaleTemp(before time.Time) error {
	tmp := filepath.Join(l.dir, "tmp")
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // removed meanwhile
		}
		if !info.ModTime().Before(before) {
			continue
		}
		if err := os.Remove(filepath.Join(tmp, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
