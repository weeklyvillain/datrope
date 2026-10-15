package voice

// SetActive makes the background loop skip its work while active reports false: the standby
// update slot (deploy/README.md, "Updates") serves requests but must not run jobs twice.
func (s *Service) SetActive(active func() bool) { s.active = active }

func (s *Service) isActive() bool { return s.active == nil || s.active() }

// Resync re-reads LiveKit soon: a slot that just went live has not synced while it was standby.
func (s *Service) Resync() {
	select {
	case s.resync <- struct{}{}:
	default: // one is already due (or voice is off: nil channel)
	}
}
