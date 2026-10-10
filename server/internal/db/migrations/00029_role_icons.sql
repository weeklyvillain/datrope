-- +goose Up
-- A role's icon: an emoji (Unicode, or "custom:<emoji id>") or an uploaded image, never both.
ALTER TABLE roles
    ADD COLUMN icon_emoji        TEXT NOT NULL DEFAULT '',
    ADD COLUMN icon_sha256       TEXT,
    ADD COLUMN icon_content_type TEXT;

-- +goose Down
ALTER TABLE roles DROP COLUMN icon_content_type, DROP COLUMN icon_sha256, DROP COLUMN icon_emoji;
