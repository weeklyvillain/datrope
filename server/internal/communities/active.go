package communities

// SetActive makes the background loop skip its work while active reports false: the standby
// update slot (deploy/README.md, "Updates") serves requests but must not run jobs twice.
func (s *Service) SetActive(active func() bool) { s.active = active }

func (s *Service) isActive() bool { return s.active == nil || s.active() }
