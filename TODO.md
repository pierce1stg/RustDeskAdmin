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
- [x] SSE endpoint (`/api/devices/stream`) with presence broadcasts
- [x] Frontend WS client (auto-reconnect, live online/offline, live timers)
- [x] Server Info API (`/api/server-info`, field sources, connect-code)

## Phase 4: Browser Remote Control (rustdesk-web protocol) ✓
- [x] Frontend WebSocket client (hbbs rendezvous + hbbr relay over WSS, PB decoder, TweetNaCl handshake)
- [x] Video decode (WebCodecs vp8/vp9/av1) + audio (Opus)
- [x] 2026-09-17: caps-gate probe (RTCRtpReceiver.getCapabilities) + G2 size ladder (720p→1080p→4K, rollback via setProbeLadderEnabled(false)) + stats codec badge (fact, not preference)
- [x] 2026-09-18: H.264/H.265 fully out of journal + login default abilities (h264:false/h265:false); journal v2 (levels/categories/search/highlight/clear, record-time gating, drop markers, collapsed count)
- [x] 2026-09-18: overrule grace 10s (no false releases on manual switch), live debug chip (no reconnect), last-good poison guard, ui audit category (all 14 toolbar actions logged)
- [x] 2026-09-18: readable input audit (describeKeyEvent: combos+symbols+raw names), hotkey wire logging, decoder picked fact line
- [x] 2026-09-18: deep floor 1/10 (stuck queue 2 ticks >300ms) for Khabarovsk<->Netherlands link physics
- [x] 2026-09-18: session chat with host user (Misc.chat_message, window+bubble, drag, persisted positions, unread badge, session-only history)
- [x] 2026-09-18: chat system messages (greeting/close, per-message toggles in panel settings) + window anchored to bubble
- [x] 2026-09-18: collapsible settings cards (all but language, persisted) + web defaults for render scale/cursor/input mode + chat emoji picker (files impossible: chat is text-only)
- [x] 2026-09-18: rank-zero fast start (~10s first ladder decision) + configurable web client name (host dialog) + acceptance guide RU/EN/ZH/AR
- [x] RemoteScreen: pointer/touch/trackpad gestures, multi-monitor switch, zoom, cursor overlay
- [x] Clipboard, hotkeys (Ctrl+Alt+Del, Alt+Tab, Win, Esc), stream quality/FPS/auto/low-latency
- [x] 2FA (TOTP) flow + saved device passwords (encrypted on server; web client pre-fill)
- [x] Keyboard input (key event proto, code → keycode mapping) + touch keyboard
- [ ] TURN server (coturn) for strict-NAT environments (works via relay today)

## DevOps / Deploy
- [x] Production Docker Compose (`docker compose` + `docker compose -f ...dev.yml`)
- [x] Nginx + Let's Encrypt (auto-renew, WSS termination)
- [x] Backup / migration guide (data/ tar + pg_dump)
- [x] GitHub Actions CI (lint, test, build)
- [ ] Backup script (scheduled PostgreSQL dump)
- [x] Health checks: `/health` is DB-aware now (backend container still lacks a compose healthcheck)
- [x] 2026-09 audit pass: graceful shutdown, HTTP timeouts + body limits, atomic refresh-token rotation,
      schema DDL at bootstrap, device undelete-on-reconnect, explicit decrypt errors, dead code removed
- [x] 2026-09 hardening: `:8080` bound to loopback only, dedicated `DEVICE_SECRET`
      (JWT fallback for old rows), gin trusted proxies (private ranges),
      `server_tokens off`, CORS fixed allow-headers + `Vary: Origin`,
      nginx `client_max_body_size 16M`, single-session `/api/auth/logout`,
      atomic refresh + refresh rate-limit, `bcrypt` 72B cap, screenshot
      content-type sniff, stricter hostname/API-URL validation, SSE
      subscriber cap, `auth_sessions` expiry index, zap production logger
- [ ] Harden (remaining): default `ALLOW_*_UPDATE=false`, httpOnly cookies for
      tokens (currently localStorage), per-endpoint rate limits on device
      password routes
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
- [x] Publish repo to GitHub (RustDeskAdmin)
- [x] Tagged release v1.0.0

---

## Priority: High → Medium → Low

**Next up:** validate the remote control on the test host under X11, then Wayland (multi-monitor coordinates, cursor host-mode); then publish to GitHub and update the archive.