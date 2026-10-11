//go:build !unix

package updater

func RunAs(string) ([]string, error) { return nil, nil }
