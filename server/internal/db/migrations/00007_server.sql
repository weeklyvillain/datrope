-- +goose Up
-- One community per instance: the server (spec: one-server design §2, §3).
ALTER TABLE communities
    ADD COLUMN description TEXT NOT NULL DEFAULT '',
    ADD COLUMN palette TEXT NOT NULL DEFAULT 'emerald'
        CHECK (palette IN ('emerald', 'ocean', 'violet', 'amber', 'rose', 'mint')),
    ADD COLUMN is_server BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX communities_one_server ON communities (is_server) WHERE is_server;

-- The oldest community becomes the server; the others fold into it.
UPDATE communities SET is_server = true
WHERE id = (SELECT id FROM communities ORDER BY created_at, id LIMIT 1);

-- Moved channels keep their @everyone overrides (the @everyone role's ID is
-- the community's ID), retargeted at the server's @everyone; overrides that
-- name the old community's other roles are dropped.
UPDATE channel_overrides o SET target_id = s.id
FROM channels ch, communities c, communities s
WHERE o.channel_id = ch.id AND ch.community_id = c.id AND NOT c.is_server AND s.is_server
  AND o.target_type = 'role' AND o.target_id = c.id;

DELETE FROM channel_overrides o USING channels ch, communities c, communities s
WHERE o.channel_id = ch.id AND ch.community_id = c.id AND NOT c.is_server AND s.is_server
  AND o.target_type = 'role' AND o.target_id <> s.id;

-- Members banned from a folded community may not read its channels (VIEW_CHANNEL = bit 0).
INSERT INTO channel_overrides (channel_id, target_type, target_id, deny)
SELECT ch.id, 'member', b.user_id, 1
FROM bans b JOIN communities c ON c.id = b.community_id AND NOT c.is_server
JOIN channels ch ON ch.community_id = c.id
ON CONFLICT (channel_id, target_type, target_id)
    DO UPDATE SET deny = channel_overrides.deny | 1, allow = channel_overrides.allow & ~1::BIGINT;

UPDATE channels ch
SET community_id = s.id, name = left(c.name || ' · ' || ch.name, 100), position = ch.position + 1000
FROM communities c, communities s
WHERE ch.community_id = c.id AND NOT c.is_server AND s.is_server;

-- Every account that is not disabled or banned is a member.
INSERT INTO members (community_id, user_id)
SELECT s.id, u.id FROM users u, communities s
WHERE s.is_server AND NOT u.disabled
  AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.community_id = s.id AND b.user_id = u.id)
ON CONFLICT DO NOTHING;

DELETE FROM communities WHERE NOT is_server;

ALTER TABLE instance_settings DROP COLUMN allow_community_creation;

-- +goose Down
ALTER TABLE instance_settings ADD COLUMN allow_community_creation BOOLEAN NOT NULL DEFAULT TRUE;
DROP INDEX communities_one_server;
ALTER TABLE communities DROP COLUMN is_server, DROP COLUMN palette, DROP COLUMN description;
