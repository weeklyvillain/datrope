-- +goose Up
-- The welcome channel and page, and the rules gate (one-server design §3, §4).
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm'));
CREATE UNIQUE INDEX channels_one_welcome ON channels (community_id) WHERE type = 'welcome';

ALTER TABLE communities
    ADD COLUMN welcome_markdown TEXT NOT NULL DEFAULT '',
    ADD COLUMN rules_gate BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE members ADD COLUMN accepted_rules_at TIMESTAMPTZ;
UPDATE members SET accepted_rules_at = joined_at;

-- A Snowflake ID as internal/id builds it: milliseconds since its epoch
-- (2026-01-01) << 22, node 1023 so it cannot collide with the app's node 0.
INSERT INTO channels (id, community_id, type, name, position)
SELECT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1767225600000) << 22 | (1023 << 12), id, 'welcome', 'welcome', -1
FROM communities WHERE is_server;

-- +goose Down
DELETE FROM channels WHERE type = 'welcome';
ALTER TABLE members DROP COLUMN accepted_rules_at;
ALTER TABLE communities DROP COLUMN rules_gate, DROP COLUMN welcome_markdown;
DROP INDEX channels_one_welcome;
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'dm'));
