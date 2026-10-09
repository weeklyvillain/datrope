-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread'));
ALTER TABLE channels
    ADD COLUMN parent_channel_id BIGINT REFERENCES channels (id) ON DELETE CASCADE,
    ADD COLUMN parent_message_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN created_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT thread_has_parent CHECK ((type = 'thread') = (parent_channel_id IS NOT NULL));
CREATE UNIQUE INDEX channels_thread_message_idx ON channels (parent_message_id) WHERE type = 'thread';
CREATE INDEX channels_thread_parent_idx ON channels (parent_channel_id) WHERE type = 'thread';

-- +goose Down
DELETE FROM channels WHERE type = 'thread';
ALTER TABLE channels DROP CONSTRAINT thread_has_parent, DROP COLUMN created_by, DROP COLUMN parent_message_id, DROP COLUMN parent_channel_id;
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm'));
