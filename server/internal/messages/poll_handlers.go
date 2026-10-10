package messages

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type VoteRequest struct {
	Positions []int `json:"positions" maxItems:"10" doc:"The chosen answers by position; empty removes the vote"`
}

// PollUpdate is the POLL_UPDATE event: counts only, never voters.
type PollUpdate struct {
	ChannelID   id.ID             `json:"channel_id"`
	MessageID   id.ID             `json:"message_id"`
	Options     []PollOptionCount `json:"options"`
	TotalVoters int               `json:"total_voters"`
	Ended       bool              `json:"ended"`
}

type PollOptionCount struct {
	Count int `json:"count"`
}

func errPollEnded() *httpx.Error {
	return httpx.E(http.StatusConflict, "POLL_ENDED", "this poll has ended")
}

func errInvalidVote(msg string) *httpx.Error { return httpx.BadRequest("INVALID_VOTE", msg) }

func pollUpdate(channelID, messageID id.ID, p *Poll) PollUpdate {
	u := PollUpdate{ChannelID: channelID, MessageID: messageID, Options: make([]PollOptionCount, len(p.Options)),
		TotalVoters: p.TotalVoters, Ended: p.Ended}
	for i, o := range p.Options {
		u.Options[i] = PollOptionCount{Count: o.Count}
	}
	return u
}

// checkVote validates positions for a poll with n answers and returns them sorted.
func checkVote(positions []int, multi bool, n int) ([]int, error) {
	if !multi && len(positions) > 1 {
		return nil, errInvalidVote("this poll takes one answer")
	}
	out := slices.Clone(positions)
	slices.Sort(out)
	for i, p := range out {
		if p < 0 || p >= n {
			return nil, errInvalidVote("there is no such answer")
		}
		if i > 0 && out[i-1] == p {
			return nil, errInvalidVote("each answer can be chosen once")
		}
	}
	if out == nil {
		out = []int{}
	}
	return out, nil
}

// withMyVotes fills my_votes for userID. Only REST responses carry it:
// hydrated messages are also broadcast (MESSAGE_UPDATE), and those go to everyone.
func (s *Service) withMyVotes(ctx context.Context, ms []Message, userID id.ID) error {
	var ids []id.ID
	for _, m := range ms {
		if m.Poll != nil {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT message_id, position FROM poll_votes WHERE message_id = ANY($1) AND user_id = $2 ORDER BY position`,
		id.Int64s(ids), userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	mine := map[id.ID][]int{}
	for rows.Next() {
		var mid id.ID
		var pos int
		if err := rows.Scan(&mid, &pos); err != nil {
			return err
		}
		mine[mid] = append(mine[mid], pos)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		if v := mine[ms[i].ID]; v != nil && ms[i].Poll != nil {
			ms[i].Poll.MyVotes = v
		}
	}
	return nil
}

func registerPolls(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("vote-poll", http.MethodPut, "/api/channels/{id}/messages/{messageID}/poll/vote", 0),
		func(ctx context.Context, in *struct {
			ID        string `path:"id"`
			MessageID string `path:"messageID"`
			Body      VoteRequest
		}) (*struct{ Body *Poll }, error) {
			ch, _, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			// The row lock orders concurrent votes and ends; publishing before Commit,
			// while it is held, makes the events go out in that same order.
			var multi, ended bool
			err = tx.QueryRow(ctx, `SELECT p.multi, `+pollEndedSQL+` FROM polls p WHERE p.message_id = $1 FOR UPDATE`, m.ID).Scan(&multi, &ended)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("poll")
			}
			if err != nil {
				return nil, err
			}
			if ended {
				return nil, errPollEnded()
			}
			var options int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM poll_options WHERE message_id = $1`, m.ID).Scan(&options); err != nil {
				return nil, err
			}
			positions, err := checkVote(in.Body.Positions, multi, options)
			if err != nil {
				return nil, err
			}
			if !s.voteLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			if _, err := tx.Exec(ctx, `DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2`, m.ID, me); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO poll_votes (message_id, position, user_id) SELECT $1, unnest($2::int[]), $3`,
				m.ID, positions, me); err != nil {
				return nil, err
			}
			polls, err := loadPolls(ctx, tx, []id.ID{m.ID})
			if err != nil {
				return nil, err
			}
			p := polls[m.ID]
			// Published under the lock (see above). If Commit then fails, the event is a
			// harmless phantom: it carries absolute state, which the next event replaces.
			s.publish("POLL_UPDATE", ch.ID, pollUpdate(ch.ID, m.ID, p))
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			p.MyVotes = positions // the event has counts only; my_votes is for this response
			return &struct{ Body *Poll }{p}, nil
		})

	huma.Register(api, op("end-poll", http.MethodPost, "/api/channels/{id}/messages/{messageID}/poll/end", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, have, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if (m.Author == nil || m.Author.ID != auth.Current(ctx).User.ID) && !have.Has(perms.ManageMessages) {
				return nil, httpx.MissingPermission()
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			var ended bool
			err = tx.QueryRow(ctx, `SELECT `+pollEndedSQL+` FROM polls p WHERE p.message_id = $1 FOR UPDATE`, m.ID).Scan(&ended)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("poll")
			}
			if err != nil {
				return nil, err
			}
			if ended {
				return nil, errPollEnded()
			}
			if _, err := tx.Exec(ctx, `UPDATE polls SET ended_at = now() WHERE message_id = $1`, m.ID); err != nil {
				return nil, err
			}
			polls, err := loadPolls(ctx, tx, []id.ID{m.ID})
			if err != nil {
				return nil, err
			}
			// Published under the row lock, so it cannot be overtaken by an earlier vote's
			// event. If Commit then fails, the phantom event is harmless (absolute state).
			s.publish("POLL_UPDATE", ch.ID, pollUpdate(ch.ID, m.ID, polls[m.ID]))
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return nil, nil
		})

	huma.Register(api, op("list-poll-voters", http.MethodGet, "/api/channels/{id}/messages/{messageID}/poll/options/{n}/voters", 0),
		func(ctx context.Context, in *struct {
			ID        string `path:"id"`
			MessageID string `path:"messageID"`
			N         int    `path:"n" minimum:"0" maximum:"9" doc:"The answer's position"`
		}) (*struct{ Body []auth.PublicUser }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			var anonymous bool
			err = s.db.QueryRow(ctx, `
				SELECT p.anonymous FROM polls p JOIN poll_options o ON o.message_id = p.message_id
				WHERE p.message_id = $1 AND o.position = $2::int`, m.ID, in.N).Scan(&anonymous)
			// Anonymous polls have no voter lists at all.
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && anonymous) {
				return nil, httpx.NotFound("poll answer")
			}
			if err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT user_id FROM poll_votes WHERE message_id = $1 AND position = $2::int ORDER BY user_id`, m.ID, in.N)
			if err != nil {
				return nil, err
			}
			ids, err := pgx.CollectRows(rows, pgx.RowTo[id.ID])
			if err != nil {
				return nil, err
			}
			users, err := s.users.PublicUsers(ctx, ids)
			if err != nil {
				return nil, err
			}
			out := make([]auth.PublicUser, 0, len(ids))
			for _, u := range ids {
				if pu, ok := users[u]; ok { // deleted accounts are skipped
					out = append(out, pu)
				}
			}
			return &struct{ Body []auth.PublicUser }{out}, nil
		})
}
