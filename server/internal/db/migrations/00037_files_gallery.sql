-- +goose Up
-- The global gallery: list a channel's files newest first, search file names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX attachments_channel_idx ON attachments (channel_id, id DESC) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_filename_trgm_idx ON attachments USING gin (filename gin_trgm_ops);

-- Playlists can hold a channel's audio file, played from the attachment's blob.
ALTER TABLE music_playlist_items
    ADD COLUMN attachment_id BIGINT REFERENCES attachments (id) ON DELETE CASCADE,
    DROP CONSTRAINT music_playlist_items_check,
    ADD CONSTRAINT music_playlist_items_source_check CHECK (num_nonnulls(track_id, url, search, attachment_id) = 1);

-- +goose Down
DELETE FROM music_playlist_items WHERE attachment_id IS NOT NULL;
ALTER TABLE music_playlist_items
    DROP CONSTRAINT music_playlist_items_source_check,
    DROP COLUMN attachment_id,
    ADD CONSTRAINT music_playlist_items_check CHECK (num_nonnulls(track_id, url, search) = 1);
DROP INDEX attachments_filename_trgm_idx;
DROP INDEX attachments_channel_idx;
