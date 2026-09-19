-- Migration: 004_auth_sessions.up.sql
-- Server-side refresh-token sessions (also created lazily by ensureTable).
CREATE TABLE IF NOT EXISTS auth_sessions (
    jti         TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    email       TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);
