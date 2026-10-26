-- +goose Up
-- How each user wants to hear about a channel. A missing row is the default:
-- the device's own level, not muted. Threads follow their parent channel.
CREATE TABLE channel_notify_settings (
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    level      TEXT NOT NULL DEFAULT 'default' CHECK (level IN ('default', 'all', 'mentions', 'nothing')),
    muted      BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX channel_notify_settings_channel_idx ON channel_notify_settings (channel_id);

-- +goose Down
DROP TABLE channel_notify_settings;
