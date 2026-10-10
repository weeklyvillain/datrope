-- +goose Up
-- Library tracks: artist and cover art from the file's tags, the stored size
-- (for the library quota), and whether the blob is the original upload or
-- already Ogg Opus (played without ffmpeg).
ALTER TABLE music_tracks
    ADD COLUMN artist     TEXT NOT NULL DEFAULT '',
    ADD COLUMN cover      TEXT,
    ADD COLUMN cover_type TEXT,
    ADD COLUMN size       BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN format     TEXT NOT NULL DEFAULT 'original' CHECK (format IN ('original', 'opus'));

-- +goose Down
ALTER TABLE music_tracks
    DROP COLUMN artist,
    DROP COLUMN cover,
    DROP COLUMN cover_type,
    DROP COLUMN size,
    DROP COLUMN format;
