-- +goose Up
-- Cache of fetched link previews (failures too, with ok = false).
CREATE TABLE link_previews (
    url         TEXT PRIMARY KEY,
    ok          BOOLEAN NOT NULL,
    site        TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN embed JSONB;

-- +goose Down
ALTER TABLE messages DROP COLUMN embed;
DROP TABLE link_previews;
