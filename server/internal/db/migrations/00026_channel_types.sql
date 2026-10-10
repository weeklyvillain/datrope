-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread', 'webhook', 'announcement', 'forum', 'gallery'));
ALTER TABLE channels
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN require_tag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE messages DROP COLUMN title;
ALTER TABLE channels DROP COLUMN require_tag, DROP COLUMN tags;
DELETE FROM channels WHERE type IN ('announcement', 'forum', 'gallery');
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread', 'webhook'));
