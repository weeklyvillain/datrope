-- +goose Up
-- A group DM stays a group when people leave, so it is never mistaken for
-- (and reused as) a 1:1 conversation.
ALTER TABLE channels ADD COLUMN dm_group BOOLEAN NOT NULL DEFAULT false;
UPDATE channels c SET dm_group = true
WHERE c.type = 'dm' AND (SELECT count(*) FROM dm_participants p WHERE p.channel_id = c.id) > 2;
-- '' for a normal message; 'member_leave' when the author left a group DM.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE messages DROP COLUMN kind;
ALTER TABLE channels DROP COLUMN dm_group;
