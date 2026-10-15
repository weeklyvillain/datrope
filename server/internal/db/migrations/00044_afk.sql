-- +goose Up
-- A voice channel that idle people get moved to, and after how long without speaking.
ALTER TABLE communities
  ADD COLUMN afk_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  ADD COLUMN afk_timeout_seconds INT NOT NULL DEFAULT 900 CHECK (afk_timeout_seconds IN (300, 900, 1800, 3600));

-- +goose Down
ALTER TABLE communities DROP COLUMN afk_timeout_seconds, DROP COLUMN afk_channel_id;
