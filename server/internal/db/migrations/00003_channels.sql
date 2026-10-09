-- +goose Up
CREATE TABLE channels (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT REFERENCES communities (id) ON DELETE CASCADE, -- NULL for DMs
    type         TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
    name         TEXT NOT NULL DEFAULT '',
    position     INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((type = 'dm') = (community_id IS NULL))
);
CREATE INDEX channels_community_idx ON channels (community_id);

-- target_id is a role ID (the community ID for @everyone) or a user ID.
CREATE TABLE channel_overrides (
    channel_id  BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
    target_id   BIGINT NOT NULL,
    allow       BIGINT NOT NULL DEFAULT 0,
    deny        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE dm_participants (
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_participants_user_idx ON dm_participants (user_id);

-- +goose Down
DROP TABLE dm_participants;
DROP TABLE channel_overrides;
DROP TABLE channels;
