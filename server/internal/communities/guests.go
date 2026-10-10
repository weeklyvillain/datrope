package communities

import (
	"context"
	"log/slog"
	"time"

	"github.com/datrope/datrope/server/internal/id"
)

// guestSweepBatch caps how many guests one pass retires.
const guestSweepBatch = 100

// retire removes a guest from the server, then disables the account and
// signs it out. Each step is idempotent, so a pass that dies half-way is
// finished by the next one.
func (s *Service) retire(ctx context.Context, serverID, userID id.ID) error {
	if _, err := s.removeMember(ctx, serverID, userID); err != nil {
		return err
	}
	return s.users.RetireUser(ctx, userID)
}

// SweepGuests retires guests whose time ran out before now and reports how many.
func (s *Service) SweepGuests(ctx context.Context, now time.Time) (int, error) {
	sid, err := s.ServerID(ctx)
	if err != nil {
		return 0, err
	}
	ids, err := s.users.ExpiredGuests(ctx, now, guestSweepBatch)
	if err != nil {
		return 0, err
	}
	for i, uid := range ids {
		if err := s.retire(ctx, sid, uid); err != nil {
			return i, err
		}
	}
	return len(ids), nil
}

// StartGuestSweep retires expired guests every minute until Close.
func (s *Service) StartGuestSweep() {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		sweep := func(now time.Time) {
			if _, err := s.SweepGuests(context.Background(), now); err != nil {
				slog.Error("communities: guest sweep", "err", err)
			}
		}
		sweep(time.Now()) // catch up after downtime
		for {
			select {
			case <-s.done:
				return
			case now := <-t.C:
				sweep(now)
			}
		}
	}()
}

func (s *Service) Close() { s.stop.Do(func() { close(s.done) }) }
