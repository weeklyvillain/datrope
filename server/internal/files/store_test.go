package files_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func TestStageAndCommitDeduplicates(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)

	a, err := s.Stage(strings.NewReader("hello"), 100)
	require.NoError(t, err)
	require.Equal(t, int64(5), a.Size)
	require.Equal(t, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", a.Sum)
	require.NoError(t, s.Commit(a))

	b, err := s.Stage(strings.NewReader("hello"), 100)
	require.NoError(t, err)
	require.NoError(t, s.Commit(b)) // same content: the staged copy is dropped

	var sums []string
	require.NoError(t, s.Walk(func(sum string, _ time.Time) error {
		sums = append(sums, sum)
		return nil
	}))
	require.Equal(t, []string{a.Sum}, sums)

	f, err := s.Open(a.Sum)
	require.NoError(t, err)
	got, err := io.ReadAll(f)
	require.NoError(t, err)
	require.NoError(t, f.Close())
	require.Equal(t, "hello", string(got))

	tmp, err := os.ReadDir(filepath.Join(dir, "tmp"))
	require.NoError(t, err)
	require.Empty(t, tmp, "no staged files are left behind")
}

func TestStageEnforcesLimit(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)

	_, err = s.Stage(bytes.NewReader(make([]byte, 11)), 10)
	require.ErrorIs(t, err, files.ErrTooLarge)
	ok, err := s.Stage(bytes.NewReader(make([]byte, 10)), 10)
	require.NoError(t, err)
	s.Discard(ok)

	tmp, err := os.ReadDir(filepath.Join(dir, "tmp"))
	require.NoError(t, err)
	require.Empty(t, tmp)
}

func TestRemoveAndInvalidSums(t *testing.T) {
	s, err := files.NewLocalStore(t.TempDir())
	require.NoError(t, err)
	a, err := s.Stage(strings.NewReader("x"), 10)
	require.NoError(t, err)
	require.NoError(t, s.Commit(a))

	require.NoError(t, s.Remove(a.Sum))
	require.NoError(t, s.Remove(a.Sum), "removing a missing file is not an error")
	_, err = s.Open(a.Sum)
	require.True(t, errors.Is(err, os.ErrNotExist))

	_, err = s.Open("../../etc/passwd")
	require.Error(t, err, "only 64-character hex names are accepted")
	require.False(t, files.ValidSum("ABC"))
}

func TestRemoveStaleTemp(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)
	stale := filepath.Join(dir, "tmp", "upload-crashed")
	require.NoError(t, os.WriteFile(stale, []byte("partial"), 0o600))

	require.NoError(t, s.RemoveStaleTemp(time.Now().Add(time.Hour)))
	_, err = os.Stat(stale)
	require.True(t, errors.Is(err, os.ErrNotExist))
}

func TestRemoveStaleTempKeepsFreshFiles(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)
	stale := filepath.Join(dir, "tmp", "upload-stale")
	fresh := filepath.Join(dir, "tmp", "upload-fresh")
	require.NoError(t, os.WriteFile(stale, []byte("old"), 0o600))
	require.NoError(t, os.WriteFile(fresh, []byte("new"), 0o600))
	old := time.Now().Add(-2 * time.Hour)
	require.NoError(t, os.Chtimes(stale, old, old))

	require.NoError(t, s.RemoveStaleTemp(time.Now().Add(-time.Hour)))
	_, err = os.Stat(stale)
	require.True(t, errors.Is(err, os.ErrNotExist), "stale staging file is removed")
	_, err = os.Stat(fresh)
	require.NoError(t, err, "fresh staging file is kept")
}
