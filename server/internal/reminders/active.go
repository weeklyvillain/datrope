package reminders

// SetActive makes the scheduler skip its work while active reports false: the standby
// update slot (deploy/README.md, "Updates") serves requests but must not fire reminders twice.
func (s *Service) SetActive(active func() bool) { s.active = active }

func (s *Service) isActive() bool { return s.active == nil || s.active() }

// Wake makes the scheduler look for due reminders now: a slot that just went live
// catches up at once instead of on its next wakeup.
func (s *Service) Wake() { s.poke() }
