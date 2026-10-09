-- +goose Up
-- Message search (M8): whole words, any language, no stemming. Queries must use the same expression.
CREATE INDEX messages_search_idx ON messages USING gin (to_tsvector('simple', content));

-- +goose Down
DROP INDEX messages_search_idx;
