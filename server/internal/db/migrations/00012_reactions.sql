-- +goose Up
-- emoji is a Unicode emoji or "custom:<emoji id>".
CREATE TABLE message_reactions (
    message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (message_id, emoji, user_id)
);
CREATE INDEX message_reactions_custom_idx ON message_reactions (emoji) WHERE emoji LIKE 'custom:%';

-- +goose Down
DROP TABLE message_reactions;
