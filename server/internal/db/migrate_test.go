package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/db"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/pgtest"
)

// Migration 7 folds every community into the oldest one, which becomes the server.
func TestServerMigrationFoldsCommunities(t *testing.T) {
	ctx := context.Background()
	pool := pgtest.New(t)
	_, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
	require.NoError(t, err)
	require.NoError(t, db.MigrateTo(ctx, pool, 6))

	_, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES
			(1, 'alice', 'alice', 'x', now() - interval '2 days'),
			(2, 'bob', 'bob', 'x', now() - interval '1 day'),
			(3, 'dora', 'dora', 'x', now());
		INSERT INTO users (id, username, display_name, password_hash, disabled) VALUES (4, 'dis', 'dis', 'x', true);
		INSERT INTO communities (id, name, owner_id, created_at) VALUES
			(10, 'Old', 1, now() - interval '2 days'),
			(20, 'Games', 2, now() - interval '1 day');
		INSERT INTO roles (id, community_id, name, permissions) VALUES
			(10, 10, '@everyone', 1), (20, 20, '@everyone', 1), (21, 20, 'Gamers', 1);
		INSERT INTO members (community_id, user_id) VALUES (10, 1), (20, 2), (20, 4);
		INSERT INTO member_roles (community_id, user_id, role_id) VALUES (20, 2, 21);
		INSERT INTO bans (community_id, user_id) VALUES (10, 3), (20, 1);
		INSERT INTO invites (code, community_id, creator_id) VALUES ('games', 20, 2);
		INSERT INTO channels (id, community_id, type, name, position) VALUES
			(100, 10, 'text', 'general', 0),
			(200, 20, 'text', 'lobby', 0);
		INSERT INTO channel_overrides (channel_id, target_type, target_id, deny) VALUES
			(100, 'role', 10, 1),
			(200, 'role', 20, 1),
			(200, 'role', 21, 2);`)
	require.NoError(t, err)

	require.NoError(t, db.Migrate(ctx, pool))

	var ids []int64
	rows, err := pool.Query(ctx, `SELECT id FROM communities WHERE is_server`)
	require.NoError(t, err)
	for rows.Next() {
		var v int64
		require.NoError(t, rows.Scan(&v))
		ids = append(ids, v)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []int64{10}, ids, "the older community is the server")
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM communities`).Scan(&n))
	require.Equal(t, 1, n)

	var community int64
	var name string
	require.NoError(t, pool.QueryRow(ctx, `SELECT community_id, name FROM channels WHERE id = 200`).Scan(&community, &name))
	require.Equal(t, int64(10), community)
	require.Equal(t, "Games · lobby", name)
	require.NoError(t, pool.QueryRow(ctx, `SELECT community_id, name FROM channels WHERE id = 100`).Scan(&community, &name))
	require.Equal(t, int64(10), community)
	require.Equal(t, "general", name)

	var deny int64
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT deny FROM channel_overrides WHERE channel_id = 200 AND target_type = 'role' AND target_id = 10`).Scan(&deny))
	require.Equal(t, int64(1), deny, "the old @everyone deny of VIEW_CHANNEL now names the server's @everyone")
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM channel_overrides WHERE channel_id = 200 AND target_type = 'role' AND target_id <> 10`).Scan(&n))
	require.Zero(t, n, "overrides naming the old community's other roles are dropped")
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT deny FROM channel_overrides WHERE channel_id = 200 AND target_type = 'member' AND target_id = 1`).Scan(&deny))
	require.Equal(t, int64(1), deny, "a member banned from the folded community may not view its channels")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM channel_overrides WHERE channel_id = 200`).Scan(&n))
	require.Equal(t, 2, n)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM channel_overrides WHERE channel_id = 100`).Scan(&n))
	require.Equal(t, 1, n, "the server's own overrides stay")

	var members []int64
	rows, err = pool.Query(ctx, `SELECT user_id FROM members WHERE community_id = 10 ORDER BY user_id`)
	require.NoError(t, err)
	for rows.Next() {
		var v int64
		require.NoError(t, rows.Scan(&v))
		members = append(members, v)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []int64{1, 2}, members, "everyone but the disabled and the banned is a member")

	for _, q := range []string{
		`SELECT count(*) FROM roles WHERE community_id = 20`,
		`SELECT count(*) FROM member_roles WHERE community_id = 20`,
		`SELECT count(*) FROM invites WHERE community_id = 20`,
		`SELECT count(*) FROM members WHERE community_id = 20`,
	} {
		require.NoError(t, pool.QueryRow(ctx, q).Scan(&n))
		require.Zero(t, n, q)
	}
}

// Migration 9 gives the server its welcome channel and accepts the rules
// for everyone who is already a member.
func TestWelcomeMigration(t *testing.T) {
	ctx := context.Background()
	pool := pgtest.New(t)
	_, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
	require.NoError(t, err)
	require.NoError(t, db.MigrateTo(ctx, pool, 8))

	var n int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_constraint WHERE conrelid = 'channels'::regclass AND conname = 'channels_type_check'`).Scan(&n))
	require.Equal(t, 1, n, "the inline CHECK on channels.type is named channels_type_check")

	_, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'alice', 'alice', 'x');
		INSERT INTO communities (id, name, owner_id, is_server) VALUES (10, 'S', 1, true);
		INSERT INTO members (community_id, user_id) VALUES (10, 1);`)
	require.NoError(t, err)
	require.NoError(t, db.MigrateTo(ctx, pool, 9)) // migration 15 renumbers positions densely

	var chID int64
	var pos int
	require.NoError(t, pool.QueryRow(ctx, `SELECT id, position FROM channels WHERE community_id = 10 AND type = 'welcome'`).Scan(&chID, &pos))
	require.Equal(t, -1, pos)
	require.WithinDuration(t, time.Now(), id.ID(chID).Time(), time.Minute, "the ID follows the Snowflake scheme")
	var accepted bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT accepted_rules_at IS NOT NULL FROM members WHERE user_id = 1`).Scan(&accepted))
	require.True(t, accepted)

	// Migration 15 renumbers every server's channels densely, welcome first.
	_, err = pool.Exec(ctx, `
		INSERT INTO channels (id, community_id, type, name, position) VALUES
			(101, 10, 'text', 'general', 0), (102, 10, 'voice', 'lounge', 7), (103, 10, 'text', 'random', 3)`)
	require.NoError(t, err)
	require.NoError(t, db.Migrate(ctx, pool))
	rows, err := pool.Query(ctx, `SELECT name, position FROM channels WHERE community_id = 10 ORDER BY position`)
	require.NoError(t, err)
	got := map[string]int{}
	var order []int
	for rows.Next() {
		var name string
		var p int
		require.NoError(t, rows.Scan(&name, &p))
		got[name] = p
		order = append(order, p)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, map[string]int{"welcome": 0, "general": 1, "random": 2, "lounge": 3}, got)
	require.Equal(t, []int{0, 1, 2, 3}, order)
}
