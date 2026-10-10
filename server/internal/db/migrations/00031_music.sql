-- +goose Up
-- The server's music library: uploaded tracks anyone can queue for the music bot.
CREATE TABLE music_tracks (
    id          BIGINT PRIMARY KEY,
    title       TEXT NOT NULL,
    duration    INTEGER NOT NULL DEFAULT 0, -- seconds; 0 when unknown
    uploaded_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    sha256      TEXT NOT NULL
);

-- +goose Down
DROP TABLE music_tracks;
