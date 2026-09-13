-- Migration: 001_create_devices_table.up.sql
CREATE TABLE IF NOT EXISTS devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    peer_id         TEXT UNIQUE NOT NULL,
    alias           TEXT,
    pinned          BOOLEAN DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    last_seen       TIMESTAMPTZ,
    online          BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_devices_peer_id ON devices(peer_id);
CREATE INDEX idx_devices_online ON devices(online) WHERE online = TRUE;
CREATE INDEX idx_devices_pinned ON devices(pinned) WHERE pinned = TRUE;
CREATE INDEX idx_devices_last_seen ON devices(last_seen DESC NULLS LAST);