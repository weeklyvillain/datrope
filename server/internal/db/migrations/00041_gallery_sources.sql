-- +goose Up
-- A gallery shows its own posts plus files from its sources: no other channel, every channel, or a
-- picked list (spec: gallery sources and wall).
ALTER TABLE channels ADD COLUMN gallery_sources TEXT CHECK (gallery_sources IN ('none', 'all', 'selected'));
UPDATE channels SET gallery_sources = 'none' WHERE type = 'gallery';
ALTER TABLE channels ADD CONSTRAINT channels_gallery_sources_set CHECK ((type = 'gallery') = (gallery_sources IS NOT NULL));

-- Rows exist only while the gallery's sources are 'selected'.
CREATE TABLE gallery_source_channels (
    gallery_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    PRIMARY KEY (gallery_id, channel_id),
    CHECK (gallery_id <> channel_id)
);
CREATE INDEX gallery_source_channels_channel_idx ON gallery_source_channels (channel_id);

-- +goose Down
DROP TABLE gallery_source_channels;
ALTER TABLE channels DROP CONSTRAINT channels_gallery_sources_set, DROP COLUMN gallery_sources;
