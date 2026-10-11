-- +goose Up
-- A channel can also follow an RSS or Atom feed (game patch notes, blogs):
-- account holds the feed URL, and title_filter keeps only entries whose
-- title contains it.
ALTER TABLE stream_alerts DROP CONSTRAINT stream_alerts_platform_check;
ALTER TABLE stream_alerts ADD CONSTRAINT stream_alerts_platform_check CHECK (platform IN ('twitch', 'youtube', 'rss'));
ALTER TABLE stream_alerts ADD COLUMN title_filter TEXT NOT NULL DEFAULT '';

-- +goose Down
DELETE FROM stream_alerts WHERE platform = 'rss';
ALTER TABLE stream_alerts DROP COLUMN title_filter;
ALTER TABLE stream_alerts DROP CONSTRAINT stream_alerts_platform_check;
ALTER TABLE stream_alerts ADD CONSTRAINT stream_alerts_platform_check CHECK (platform IN ('twitch', 'youtube'));
