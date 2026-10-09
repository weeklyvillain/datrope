-- +goose Up
ALTER TABLE messages
    ADD COLUMN pinned_at TIMESTAMPTZ,
    ADD COLUMN pinned_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX messages_pins_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- +goose Down
DROP INDEX messages_pins_idx;
ALTER TABLE messages DROP COLUMN pinned_by, DROP COLUMN pinned_at;
