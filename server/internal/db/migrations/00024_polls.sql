-- +goose Up
-- A message's poll. Messages are soft-deleted, so the messages handler
-- deletes the poll itself; the cascades cover hard deletes (channel deletion).
CREATE TABLE polls (
    message_id BIGINT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    multi      BOOLEAN NOT NULL DEFAULT FALSE,
    anonymous  BOOLEAN NOT NULL DEFAULT FALSE,
    ends_at    TIMESTAMPTZ,
    ended_at   TIMESTAMPTZ
);
CREATE TABLE poll_options (
    message_id BIGINT NOT NULL REFERENCES polls (message_id) ON DELETE CASCADE,
    position   SMALLINT NOT NULL,
    text       TEXT NOT NULL,
    emoji      TEXT,
    PRIMARY KEY (message_id, position)
);
CREATE TABLE poll_votes (
    message_id BIGINT NOT NULL,
    position   SMALLINT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, position, user_id),
    FOREIGN KEY (message_id, position) REFERENCES poll_options (message_id, position) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE poll_votes;
DROP TABLE poll_options;
DROP TABLE polls;
