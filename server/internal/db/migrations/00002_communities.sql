-- +goose Up
CREATE TABLE communities (
    id         BIGINT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   BIGINT NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The @everyone role has the same ID as its community.
CREATE TABLE roles (
    id           BIGINT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    permissions  BIGINT NOT NULL,
    position     INT NOT NULL DEFAULT 0
);
CREATE INDEX roles_community_idx ON roles (community_id);

CREATE TABLE members (
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id)
);
CREATE INDEX members_user_idx ON members (user_id);

CREATE TABLE member_roles (
    community_id BIGINT NOT NULL,
    user_id      BIGINT NOT NULL,
    role_id      BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, user_id, role_id),
    FOREIGN KEY (community_id, user_id) REFERENCES members (community_id, user_id) ON DELETE CASCADE
);

CREATE TABLE bans (
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason       TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id)
);

CREATE TABLE invites (
    code         TEXT PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    creator_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    max_uses     INT,          -- NULL = unlimited
    uses         INT NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ,  -- NULL = never
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invites_community_idx ON invites (community_id);

-- +goose Down
DROP TABLE invites;
DROP TABLE bans;
DROP TABLE member_roles;
DROP TABLE members;
DROP TABLE roles;
DROP TABLE communities;
