-- +goose Up
CREATE TABLE categories (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INT NOT NULL DEFAULT 0
);
CREATE INDEX categories_community_idx ON categories (community_id, position);

ALTER TABLE channels
    ADD COLUMN category_id BIGINT REFERENCES categories (id) ON DELETE SET NULL,
    ADD COLUMN topic TEXT NOT NULL DEFAULT '';

-- Dense positions per group: the welcome channel first, then the rest in their current order.
UPDATE channels ch SET position = o.n - 1
FROM (SELECT id, row_number() OVER (PARTITION BY community_id ORDER BY (type = 'welcome') DESC, position, id) AS n
      FROM channels WHERE community_id IS NOT NULL) o
WHERE ch.id = o.id;

-- +goose Down
ALTER TABLE channels DROP COLUMN topic, DROP COLUMN category_id;
DROP TABLE categories;
