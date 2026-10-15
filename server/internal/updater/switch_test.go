package updater

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	return string(b)
}

func TestSwitchWriteAndRestore(t *testing.T) {
	dir := t.TempDir()
	s := Switch{Dir: dir}
	slot, err := s.Active()
	require.NoError(t, err)
	require.Equal(t, "blue", slot, "no file yet: blue")

	_, err = s.Write("blue", "aaa")
	require.NoError(t, err)
	restore, err := s.Write("green", "bbb")
	require.NoError(t, err)
	require.Equal(t, "green\n", read(t, filepath.Join(dir, "slot")))
	require.Equal(t, "reverse_proxy server-green:8080\n", read(t, filepath.Join(dir, "upstream.caddy")))
	require.Equal(t, "root * /web/bbb\n", read(t, filepath.Join(dir, "root.caddy")))
	slot, err = s.Active()
	require.NoError(t, err)
	require.Equal(t, "green", slot)

	require.NoError(t, restore())
	require.Equal(t, "blue\n", read(t, filepath.Join(dir, "slot")))
	require.Equal(t, "reverse_proxy server-blue:8080\n", read(t, filepath.Join(dir, "upstream.caddy")))
	require.Equal(t, "root * /web/aaa\n", read(t, filepath.Join(dir, "root.caddy")))
	m, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	require.Empty(t, m, "no temp files left")
}

func TestSwitchRestoreRemovesNewFiles(t *testing.T) {
	dir := t.TempDir()
	restore, err := Switch{Dir: dir}.Write("green", "bbb")
	require.NoError(t, err)
	require.NoError(t, restore())
	_, err = os.Stat(filepath.Join(dir, "slot"))
	require.True(t, os.IsNotExist(err))
}

func TestSwitchRejectsBadInput(t *testing.T) {
	_, err := Switch{Dir: t.TempDir()}.Write("red", "aaa")
	require.Error(t, err)
	_, err = Switch{Dir: t.TempDir()}.Write("blue", "../x")
	require.Error(t, err)
	_, err = Switch{Dir: t.TempDir()}.Write("blue", "")
	require.Error(t, err)
}

func TestOther(t *testing.T) {
	require.Equal(t, "green", Other("blue"))
	require.Equal(t, "blue", Other("green"))
}
