-- +goose Up
-- Roles members give themselves on the welcome page, and roles anyone may ping.
ALTER TABLE roles
  ADD COLUMN self_assignable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN mentionable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 120);
-- The roles a message pinged (resolved at send/edit time).
ALTER TABLE messages ADD COLUMN mention_roles BIGINT[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE messages DROP COLUMN mention_roles;
ALTER TABLE roles DROP COLUMN description, DROP COLUMN mentionable, DROP COLUMN self_assignable;
