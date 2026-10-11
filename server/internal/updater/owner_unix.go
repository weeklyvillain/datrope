//go:build unix

package updater

import (
	"fmt"
	"os"
	"syscall"
)

// RunAs is the su-exec prefix that runs a command as dir's owner; nil when root owns it.
func RunAs(dir string) ([]string, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid == 0 {
		return nil, nil
	}
	return []string{"su-exec", fmt.Sprintf("%d:%d", sys.Uid, sys.Gid)}, nil
}
