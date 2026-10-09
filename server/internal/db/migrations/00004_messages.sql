-- +goose Up
-- A message's creation time is encoded in its Snowflake ID.
CREATE TABLE messages (
    id         BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users (id),
    content    TEXT NOT NULL,
    edited_at  TIMESTAMPTZ,
    deleted    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);

CREATE TABLE read_states (
    user_id         BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id      BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_message_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- +goose Down
DROP TABLE read_states;
DROP TABLE messages;
