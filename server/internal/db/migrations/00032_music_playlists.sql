-- +goose Up
-- Saved playlists: the server's, shared like the music library.
CREATE TABLE music_playlists (
    id         BIGINT PRIMARY KEY, -- snowflake; created_at is its time
    title      TEXT NOT NULL,
    created_by BIGINT REFERENCES users (id) ON DELETE SET NULL
);

-- A playlist's tracks, in order: a library upload, a link, or a search that is
-- resolved when the track comes up (Spotify tracks).
CREATE TABLE music_playlist_items (
    id          BIGINT PRIMARY KEY,
    playlist_id BIGINT NOT NULL REFERENCES music_playlists (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    BIGINT REFERENCES music_tracks (id) ON DELETE CASCADE,
    url         TEXT,
    search      TEXT,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL DEFAULT '',
    duration    INTEGER NOT NULL DEFAULT 0, -- seconds; 0 when unknown
    site        TEXT NOT NULL DEFAULT '',   -- the link's site ("youtube", "soundcloud", ...)
    cover       TEXT,                       -- blob sum of the cover image
    cover_type  TEXT,
    added_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
    CHECK (num_nonnulls(track_id, url, search) = 1),
    UNIQUE (playlist_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- +goose Down
DROP TABLE music_playlist_items;
DROP TABLE music_playlists;
