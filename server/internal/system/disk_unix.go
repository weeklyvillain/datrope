//go:build unix

package system

import "syscall"

// diskUsage reports the filesystem holding path. used counts what ordinary users can no longer write.
func diskUsage(path string) (used, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	total = st.Blocks * bs
	return total - st.Bavail*bs, total, nil
}
