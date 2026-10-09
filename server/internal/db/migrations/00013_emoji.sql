-- +goose Up
CREATE TABLE emoji (
    id           BIGINT PRIMARY KEY,
    name         TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_]{2,32}$'),
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    creator_id   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emoji_name_idx ON emoji (lower(name));
CREATE INDEX emoji_sha_idx ON emoji (sha256);

-- +goose Down
DROP TABLE emoji;
