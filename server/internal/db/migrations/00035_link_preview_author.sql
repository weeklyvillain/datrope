-- +goose Up
-- Who made the linked thing (a YouTube video's channel), when the site says.
ALTER TABLE link_previews ADD COLUMN author TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE link_previews DROP COLUMN author;
