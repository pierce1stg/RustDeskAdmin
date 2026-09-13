# RustDesk Admin - TODO

## Phase 0: Infrastructure ✓
- [x] Docker Compose (PostgreSQL, Backend, Frontend, Nginx, hbbs, hbbr, presence, certbot)
- [x] Go backend scaffold (Gin, air hot reload)
- [x] Frontend scaffold (React + TS, Vite, shadcn/ui, Tailwind)
- [x] Dockerfiles (dev + prod stages; go mod vendor, multi-stage)
- [x] Nginx reverse proxy (${DOMAIN} template, ACME webroot, WSS 21118/21119, SPA fallback)
- [x] Dev overlay (`docker-compose.dev.yml`: air hot reload + Vite dev server)
- [x] `setup.sh` idempotent bootstrap (secrets seed, data/status, TLS placeholder, cert issue, prune)
- [x] `Makefile` helper commands
- [x] Download mirrors (Block C): `DOCKER_REGISTRY_PREFIX`, `GOPROXY`, `NPM_REGISTRY`, `APK_MIRROR`
- [x] Docker cleanup after build (Block D): `DOCKER_PRUNE_ON_BUILD` all/safe/none

## Phase 1: Auth + Device Backend ✓
- [x] Login endpoint (access + refresh JWT)
- [x] Refresh token endpoint
- [x] Change admin credentials (≥8 chars, bcrypt)
- [x] Auth middleware (JWT validation)
- [x] Admin credentials seeded from `.env` (Block B)
- [x] hbbs SQLite reader (`db_v2.sqlite3` → peers) with graceful missing-file handling
- [x] Sync to PostgreSQL `devices` table (30s, configurable)
- [x] Live online/offline tracked via presence snapshots
- [x] `GET /api/devices` (pagination)
- [x] `PATCH /api/devices/:id` (alias, pinned)
- [x] `DELETE /api/devices/:id` (soft delete)
- [x] DB migrations + indexes (peer_id, online, pinned, last_seen)

## Phase 2: Frontend UI ✓
- [x] Login page (react-hook-form + Zod)
- [x] JWT storage + axios refresh interceptor
- [x] Protected routes
- [x] Sidebar + header (responsive)
- [x] Devices page: table, search, pagination, pin/unpin, alias edit dialog, delete confirm
- [x] Loading / empty / error states
- [x] Toast notifications
- [x] i18n: EN / RU / ZH / AR

## Phase 3: Real-time Updates ✓
- [x] WebSocket endpoint (`/api/ws/devices`) with presence broadcasts
- [x] Frontend WS client (auto-reconnect, live online/offline, live timers)
- [x] Server Info API (`/api/server-info`, field sources, connect-code)

## Phase 4: WebRTC Remote Control (separate / not started)
- [ ] Signaling proxy (Go WS → hbbs protobuf)
- [ ] WebRTC stack (frontend: RTCPeerConnection)
- [ ] Media server (Go: pion/webrtc)
- [ ] Remote view / data channels / clipboard
- [ ] TURN server (coturn)

## DevOps / Deploy
- [x] Production Docker Compose (`docker compose` + `docker compose -f ...dev.yml`)
- [x] Nginx + Let's Encrypt (auto-renew, WSS termination)
- [x] Backup / migration guide (data/ tar + pg_dump)
- [ ] GitHub Actions CI (lint, test, build)
- [ ] Backup script (scheduled PostgreSQL dump)
- [ ] Health checks + monitoring
- [ ] Docker registry images pushed to a public registry

## Testing
- [ ] Unit tests (auth, device service)
- [ ] Integration tests (API endpoints)
- [ ] E2E tests (Playwright)
- [ ] Load testing (k6)

## Documentation
- [x] README (EN / RU / ZH / AR)
- [ ] API spec (OpenAPI/Swagger)
- [ ] Architecture decision records (ADR)

## Git / Release
- [ ] Publish repo to GitHub (RustDeskAdmin)
- [ ] Initial tagged release (v0.1.0)

---

## Priority: High → Medium → Low

**Next up:** deploy the audited/cleaned build to the test host (`docker compose build backend` + frontend image `354ef4397110`), verify `/api/status` and the new bundle; then publish to GitHub and update the archive.