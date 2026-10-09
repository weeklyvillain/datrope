-- +goose Up
CREATE TABLE sounds (
    id           BIGINT PRIMARY KEY,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    emoji        TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    duration_ms  INT NOT NULL,
    creator_id   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sounds_sha_idx ON sounds (sha256);

-- +goose Down
DROP TABLE sounds;
