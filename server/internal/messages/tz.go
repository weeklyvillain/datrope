package messages

import "time"

// cleanTZ keeps a client's IANA zone only if this server knows it; anything else is stored as no zone.
func cleanTZ(s string) *string {
	if s == "" || len(s) > 64 || s == "Local" {
		return nil
	}
	if _, err := time.LoadLocation(s); err != nil {
		return nil
	}
	return &s
}
