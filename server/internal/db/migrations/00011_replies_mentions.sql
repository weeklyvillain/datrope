-- +goose Up
ALTER TABLE messages
    ADD COLUMN reply_to_id BIGINT REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN mentions BIGINT[] NOT NULL DEFAULT '{}';
CREATE INDEX messages_mentions_idx ON messages USING gin (mentions);

-- +goose Down
DROP INDEX messages_mentions_idx;
ALTER TABLE messages DROP COLUMN mentions, DROP COLUMN reply_to_id;
