-- +goose Up
-- App credentials for Twitch and Spotify, set by an instance admin (write-only, like the Klipy key).
ALTER TABLE instance_settings
    ADD COLUMN twitch_client_id      TEXT,
    ADD COLUMN twitch_client_secret  TEXT,
    ADD COLUMN spotify_client_id     TEXT,
    ADD COLUMN spotify_client_secret TEXT;

-- A channel follows a Twitch streamer or a YouTube channel and gets a message
-- when they go live (Twitch) or post a video (YouTube).
CREATE TABLE stream_alerts (
    id           BIGINT PRIMARY KEY,
    channel_id   BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    platform     TEXT NOT NULL CHECK (platform IN ('twitch', 'youtube')),
    account      TEXT NOT NULL, -- a Twitch login (lower case) or a YouTube channel ID
    display_name TEXT NOT NULL,
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    live         BOOLEAN NOT NULL DEFAULT false, -- Twitch: live at the last check
    last_item    TEXT NOT NULL DEFAULT '',       -- YouTube: the newest video already announced
    UNIQUE (channel_id, platform, account)
);

-- An account a user linked so others see what they are doing.
CREATE TABLE connections (
    user_id       BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider      TEXT NOT NULL CHECK (provider IN ('twitch', 'spotify')),
    account_id    TEXT NOT NULL,
    account_name  TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at    TIMESTAMPTZ NOT NULL,
    show_activity BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (user_id, provider)
);

-- +goose Down
DROP TABLE connections;
DROP TABLE stream_alerts;
ALTER TABLE instance_settings
    DROP COLUMN spotify_client_secret, DROP COLUMN spotify_client_id,
    DROP COLUMN twitch_client_secret, DROP COLUMN twitch_client_id;
