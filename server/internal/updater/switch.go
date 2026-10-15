package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Switch is the directory (the switch volume) that says which server slot is live and which web
// build Caddy serves. Caddy imports upstream.caddy and root.caddy; the servers read slot.
type Switch struct{ Dir string }

var buildRe = regexp.MustCompile(`^[0-9A-Za-z._-]{1,64}$`)

// Other is the slot that is not slot.
func Other(slot string) string {
	if slot == "blue" {
		return "green"
	}
	return "blue"
}

// Active is the live slot; blue before the first switch.
func (s Switch) Active() (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, "slot"))
	if errors.Is(err, os.ErrNotExist) {
		return "blue", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Write points Caddy and the servers at slot and build. slot goes last, so a crash in between
// leaves the servers on the old slot. restore undoes the write.
func (s Switch) Write(slot, build string) (restore func() error, err error) {
	if slot != "blue" && slot != "green" {
		return nil, fmt.Errorf("switch: bad slot %q", slot)
	}
	if !buildRe.MatchString(build) || strings.Contains(build, "..") {
		return nil, fmt.Errorf("switch: bad build %q", build)
	}
	files := []struct{ name, body string }{
		{"upstream.caddy", "reverse_proxy server-" + slot + ":8080\n"},
		{"root.caddy", "root * /web/" + build + "\n"},
		{"slot", slot + "\n"},
	}
	type saved struct {
		name string
		body []byte
		ok   bool
	}
	var prev []saved
	restore = func() error {
		var errs []error
		for i := len(prev) - 1; i >= 0; i-- {
			p := prev[i]
			if p.ok {
				errs = append(errs, s.put(p.name, p.body))
			} else {
				errs = append(errs, os.Remove(filepath.Join(s.Dir, p.name)))
			}
		}
		return errors.Join(errs...)
	}
	for _, f := range files {
		b, rerr := os.ReadFile(filepath.Join(s.Dir, f.name))
		prev = append(prev, saved{f.name, b, rerr == nil})
		if err := s.put(f.name, []byte(f.body)); err != nil {
			_ = restore()
			return nil, err
		}
	}
	return restore, nil
}

func (s Switch) put(name string, body []byte) error {
	tmp := filepath.Join(s.Dir, name+".tmp")
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.Dir, name))
}
