//go:build !unix

package system

import "errors"

func diskUsage(string) (used, total uint64, err error) {
	return 0, 0, errors.New("system: disk usage needs a unix system")
}
