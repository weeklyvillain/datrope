-- +goose Up
-- The server's icon and banner (one each) and images used on the welcome page.
CREATE TABLE server_images (
    id           BIGINT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('icon', 'banner', 'page')),
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX server_images_one_each ON server_images (kind) WHERE kind IN ('icon', 'banner');
CREATE INDEX server_images_sha_idx ON server_images (sha256);

-- +goose Down
DROP TABLE server_images;
