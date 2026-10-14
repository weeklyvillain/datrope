-- +goose Up
-- Albums are folders inside a gallery channel and hold only files posted in channels; the old
-- personal albums and their direct uploads go (spec: gallery sources and wall). Blob files of the
-- deleted uploads are reclaimed by files.Sweep once nothing references them.
DELETE FROM album_items;
DELETE FROM album_members;
DELETE FROM albums;
DELETE FROM attachments WHERE album_id IS NOT NULL;
DROP INDEX attachments_album_idx;
ALTER TABLE attachments DROP CONSTRAINT attachments_home_check, DROP COLUMN album_id;
ALTER TABLE attachments ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE albums
    ADD COLUMN gallery_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    DROP CONSTRAINT albums_visibility_check,
    ADD CONSTRAINT albums_visibility_check CHECK (visibility IN ('private', 'gallery')),
    ALTER COLUMN visibility SET DEFAULT 'gallery';
CREATE INDEX albums_gallery_idx ON albums (gallery_id);

-- +goose Down
DELETE FROM album_items;
DELETE FROM album_members;
DELETE FROM albums;
DROP INDEX albums_gallery_idx;
ALTER TABLE albums
    DROP COLUMN gallery_id,
    DROP CONSTRAINT albums_visibility_check,
    ADD CONSTRAINT albums_visibility_check CHECK (visibility IN ('private', 'server')),
    ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE attachments
    ALTER COLUMN channel_id DROP NOT NULL,
    ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE CASCADE,
    ADD CONSTRAINT attachments_home_check CHECK ((channel_id IS NULL) <> (album_id IS NULL));
CREATE INDEX attachments_album_idx ON attachments (album_id) WHERE album_id IS NOT NULL;
