-- +goose Up
ALTER TABLE roles
    ADD COLUMN color TEXT CHECK (color IN ('#e74c3c', '#f5a524', '#2ecc71', '#2dd4bf', '#4aa3ff', '#a78bfa', '#fb7185', '#969da2')),
    ADD COLUMN hoist BOOLEAN NOT NULL DEFAULT false;

-- New flags for @everyone: ADD_REACTIONS (1<<17), CREATE_THREADS (1<<18), USE_SOUNDBOARD (1<<19).
UPDATE roles SET permissions = permissions | (1 << 17) | (1 << 18) | (1 << 19) WHERE id = community_id;

-- Make role positions unique and dense (@everyone stays 0).
UPDATE roles r SET position = o.n
FROM (SELECT id, row_number() OVER (PARTITION BY community_id ORDER BY position, id) AS n
      FROM roles WHERE id <> community_id) o
WHERE r.id = o.id;

ALTER TABLE users ADD COLUMN custom_status TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE users DROP COLUMN custom_status;
UPDATE roles SET permissions = permissions & ~((1 << 17) | (1 << 18) | (1 << 19)) WHERE id = community_id;
ALTER TABLE roles DROP COLUMN hoist, DROP COLUMN color;
