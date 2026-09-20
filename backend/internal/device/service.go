package device

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/mattn/go-sqlite3"
	"go.uber.org/zap"

	"rustdesk-admin/internal/settings"
)

const onlineWatcherInterval = 5 * time.Second

// presenceTimeout is how long a presence snapshot may be before it is treated
// as stale. presence.sh writes a fresh snapshot every 10s, so a fixed window
// comfortably covers missed ticks regardless of the refresh interval.
const presenceTimeout = 45 * time.Second

type Service struct {
	pool         *pgxpool.Pool
	hbbDBPath    string
	presencePath string
	// hbbsAddr is host:port of the rendezvous server's NAT-test listener
	// (hbbs:21115) used for authoritative per-peer online queries.
	hbbsAddr string
	logger   *zap.Logger
	settings *settings.Store

	// encSecret encrypts device passwords at rest (AES-256-GCM keyed by
	// SHA-256 of the panel's device secret). encFallback is the legacy
	// JWT-derived key, tried on decrypt only so rotating to a dedicated
	// secret does not lose already-saved passwords.
	encSecret   []byte
	encFallback []byte

	mu sync.Mutex

	// schemaOnce guards the lazy ADD COLUMN migrations for the password fields.
	schemaOnce sync.Once
	// peerinfoSchemaOnce guards the lazy ADD COLUMN migrations for the
	// PeerInfo snapshot fields (same reason, separate gate).
	peerinfoSchemaOnce sync.Once

	lastPresence *presenceSnapshot

	// peerPrimary maps hex peer id -> current IP last observed in the hbbs
	// logs (presence peer_ips). peerInfoIP is the fallback recorded at
	// registration (peer.info) captured during discovery sync.
	peerPrimary map[string]string
	peerInfoIP  map[string]string

	// lastOnline keeps the last time each hex peer was seen online so a brief
	// gap (re-registration / presence tick miss) does not flap the flag.
	lastOnline map[string]time.Time

	// peerPrimaryTs tracks when each peerPrimary mapping was last confirmed
	// so stale associations expire instead of pinning peers to dead IPs.
	peerPrimaryTs map[string]int64

	// onlineState is the hex peer -> online flag as last written/published.
	onlineState map[string]bool

	// onlineSource explains WHY a peer is currently flagged online:
	// "conn:<ip>" (live socket seen in the snapshot) or "grace:<rfc3339>"
	// (no socket, held by the grace window until the timestamp). Deleted
	// when the peer flips offline. Diagnostic only, served in the list DTO.
	onlineSource map[string]string

	subs       map[chan StatusEvent]struct{}
	lastStatus *StatusEvent
}

type presenceConn struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
	// Ms since this socket last received data (ss lastrcv). Absent when the
	// sampler could not report it — treated as active (fail open).
	LastRcvMs *int64 `json:"lastrcv_ms,omitempty"`
}

// connActiveAfterMs is the max socket silence (ms) after which a connection
// no longer proves its peer alive. Live RustDesk clients talk every few
// seconds (observed lastrcv ~5-15s); ghosts of powered-off PCs stay silent
// for hours, so the margin is orders of magnitude wide either way.
const connActiveAfterMs = 300_000

func connIsActive(lastRcvMs *int64) bool {
	if lastRcvMs == nil {
		return true
	}
	return *lastRcvMs <= connActiveAfterMs
}

type presenceSnapshot struct {
	Ts            int64               `json:"ts"`
	Hbbs          []string            `json:"hbbs"`
	Hbbr          []string            `json:"hbbr"`
	HbbsListening bool                `json:"hbbs_listening"`
	HbbrListening bool                `json:"hbbr_listening"`
	PeerIPs       map[string][]string `json:"peer_ips"`
	HbbsVersion   string              `json:"hbbs_version"`
	HbbrVersion   string              `json:"hbbr_version"`
	HbbsConns     []presenceConn      `json:"hbbs_conns"`
	HbbrConns     []presenceConn      `json:"hbbr_conns"`
}

type StatusEvent struct {
	TS     time.Time `json:"ts"`
	Online []string  `json:"online"`
	Count  int       `json:"online_count"`
}

type Device struct {
	ID        uuid.UUID  `json:"id"`
	PeerID    string     `json:"peer_id"`
	Alias     *string    `json:"alias"`
	Pinned    bool       `json:"pinned"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	LastSeen  *time.Time `json:"last_seen,omitempty"`
	Online    bool       `json:"online"`
	// Why the peer is flagged online ("conn:<ip>" / "grace:<rfc3339>");
	// absent when offline or unknown (e.g. right after a backend restart).
	OnlineSource  *string   `json:"online_source,omitempty"`
	PasswordSaved bool      `json:"password_saved"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	// Last-known PeerInfo snapshot (written by the web client on session
	// login; NULL until the first panel connect).
	Hostname          *string    `json:"hostname,omitempty"`
	Username          *string    `json:"username,omitempty"`
	Platform          *string    `json:"platform,omitempty"`
	HostVersion       *string    `json:"host_version,omitempty"`
	Displays          *string    `json:"displays,omitempty"`
	PeerinfoUpdatedAt *time.Time `json:"peerinfo_updated_at,omitempty"`
}

// PeerInfoDisplay is one monitor as reported by the host.
type PeerInfoDisplay struct {
	Name   string `json:"name,omitempty"`
	X      int    `json:"x,omitempty"`
	Y      int    `json:"y,omitempty"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type UpdatePeerInfoRequest struct {
	Hostname    *string           `json:"hostname"`
	Username    *string           `json:"username"`
	Platform    *string           `json:"platform"`
	HostVersion *string           `json:"host_version"`
	Displays    []PeerInfoDisplay `json:"displays"`
}

type StatusConn struct {
	IP     string `json:"ip"`
	Port   int    `json:"port,omitempty"`
	PeerID string `json:"peer_id,omitempty"`
	Alias  string `json:"alias,omitempty"`
	// Stale marks rows that must not be read as "peer online": the socket
	// carried no recent traffic (ghost leftover) or the attributed peer is
	// offline per the last computed flags.
	Stale bool `json:"stale,omitempty"`
}

type ServerStatus struct {
	HbbsListening bool         `json:"hbbs_listening"`
	HbbrListening bool         `json:"hbbr_listening"`
	RelayActive   bool         `json:"relay_active"`
	RelayClients  []string     `json:"relay_clients"`
	HbbsClients   []string     `json:"hbbs_clients"`
	HbbsVersion   string       `json:"hbbs_version,omitempty"`
	HbbrVersion   string       `json:"hbbr_version,omitempty"`
	HbbsDevices   int          `json:"hbbs_devices"`
	HbbrDevices   int          `json:"hbbr_devices"`
	HbbsConns     []StatusConn `json:"hbbs_conns"`
	HbbrConns     []StatusConn `json:"hbbr_conns"`
	UpdatedAt     time.Time    `json:"updated_at,omitempty"`
}

type ListDevicesRequest struct {
	Page   int    `form:"page,default=1"`
	Limit  int    `form:"limit,default=20"`
	Search string `form:"search"`
	// Comma-separated searchable columns (whitelist enforced); empty = all.
	Fields string `form:"fields"`
	// Per-column match ops "col:op" (op = contains|exact|starts); unknown
	// entries fall back to contains.
	Ops    string `form:"ops"`
	Pinned *bool  `form:"pinned"`
	Online *bool  `form:"online"`
}

// searchFieldWhitelist maps API field names to devices columns. peer_id is
// stored hex-encoded, so decimal input is encoded too (see searchClauses).
var searchFieldWhitelist = map[string]string{
	"alias":        "alias",
	"peer_id":      "peer_id",
	"hostname":     "hostname",
	"username":     "username",
	"platform":     "platform",
	"host_version": "host_version",
}

// searchClauses builds the OR-ed ILIKE/LIKE conditions for a search term.
// Pure (no DB) so it stays unit-testable.
func searchClauses(search, fields, ops string) (clause string, args []interface{}) {
	if len(search) > maxSearchLen {
		search = search[:maxSearchLen]
	}
	wanted := map[string]bool{}
	if fields != "" {
		for _, f := range strings.Split(fields, ",") {
			f = strings.TrimSpace(f)
			if _, ok := searchFieldWhitelist[f]; ok {
				wanted[f] = true
			}
		}
	}
	if len(wanted) == 0 {
		for f := range searchFieldWhitelist {
			wanted[f] = true
		}
	}
	opByField := map[string]string{}
	if ops != "" {
		for _, e := range strings.Split(ops, ",") {
			kv := strings.SplitN(strings.TrimSpace(e), ":", 2)
			if len(kv) != 2 {
				continue
			}
			if _, ok := searchFieldWhitelist[kv[0]]; !ok {
				continue
			}
			switch kv[1] {
			case "exact", "starts", "contains":
				opByField[kv[0]] = kv[1]
			}
		}
	}
	pattern := func(op, term string) string {
		switch op {
		case "exact":
			return term
		case "starts":
			return term + "%"
		default:
			return "%" + term + "%"
		}
	}
	// Deterministic column order for stable tests and queries.
	ordered := []string{"alias", "peer_id", "hostname", "username", "platform", "host_version"}
	parts := []string{}
	idx := 1
	for _, f := range ordered {
		if !wanted[f] {
			continue
		}
		col := searchFieldWhitelist[f]
		op := opByField[f]
		parts = append(parts, col+" ILIKE "+sqlArg(idx))
		args = append(args, pattern(op, search))
		idx++
		if f == "peer_id" && isDecimalID(search) {
			parts = append(parts, col+" ILIKE "+sqlArg(idx))
			args = append(args, pattern(op, strings.ToUpper(hex.EncodeToString([]byte(search)))))
			idx++
		}
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}

func isDecimalID(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

type ListDevicesResponse struct {
	Items []Device `json:"items"`
	Total int64    `json:"total"`
	Page  int      `json:"page"`
	Limit int      `json:"limit"`
}

type UpdateDeviceRequest struct {
	Alias  *string `json:"alias"`
	Pinned *bool   `json:"pinned"`
}

func NewService(pool *pgxpool.Pool, hbbDBPath, presencePath string, encSecret string, settingsStore *settings.Store, logger *zap.Logger, hbbsOnlineAddr string, encFallback ...string) *Service {
	fallback := ""
	if len(encFallback) > 0 {
		fallback = encFallback[0]
	}
	var fallbackBytes []byte
	if fallback != "" && fallback != encSecret {
		fallbackBytes = []byte(fallback)
	}
	return &Service{
		pool:          pool,
		hbbDBPath:     hbbDBPath,
		presencePath:  presencePath,
		hbbsAddr:      hbbsOnlineAddr,
		logger:        logger,
		settings:      settingsStore,
		encSecret:     []byte(encSecret),
		encFallback:   fallbackBytes,
		lastOnline:    make(map[string]time.Time),
		peerPrimary:   make(map[string]string),
		peerPrimaryTs: make(map[string]int64),
		peerInfoIP:    make(map[string]string),
		onlineState:   make(map[string]bool),
		onlineSource:  make(map[string]string),
		subs:          make(map[chan StatusEvent]struct{}),
	}
}

// decryptPassword tries the current device secret first, then the legacy
// JWT-derived key, so migrating to a dedicated secret never loses rows.
func (s *Service) decryptPassword(enc string) (string, error) {
	plain, err := decryptSecret(s.encSecret, enc)
	if err == nil {
		return plain, nil
	}
	if len(s.encFallback) > 0 {
		if fallback, ferr := decryptSecret(s.encFallback, enc); ferr == nil {
			return fallback, nil
		}
	}
	return "", err
}

// maxStatusSubscribers caps concurrent SSE holders so one authenticated
// client cannot exhaust file descriptors / memory with endless streams.
const maxStatusSubscribers = 200

// maxSearchLen caps the devices search string (LIKE wildcards make long
// patterns expensive).
const maxSearchLen = 64

// maxAliasLen caps device aliases stored via the panel.
const maxAliasLen = 64

func (s *Service) refreshInterval() time.Duration {
	if s.settings == nil {
		return time.Duration(settings.DefaultRefreshInterval) * time.Second
	}
	sec := s.settings.GetRefreshInterval(context.Background())
	return time.Duration(sec) * time.Second
}

func (s *Service) statusRefreshMode() string {
	if s.settings == nil {
		return settings.DefaultStatusRefreshMode
	}
	return s.settings.GetStatusRefreshMode(context.Background())
}

func (s *Service) offlineGrace() time.Duration { return s.refreshInterval() * 3 }

func (s *Service) StartSync(ctx context.Context) {
	interval := s.refreshInterval()
	if interval < time.Second {
		interval = time.Duration(settings.DefaultRefreshInterval) * time.Second
	}

	go s.startOnlineWatcher(ctx)

	// Initial sync
	s.syncDevices(ctx)

	for {
		if ctx.Err() != nil {
			return
		}

		interval = s.refreshInterval()
		time.Sleep(interval)
		s.syncDevices(ctx)
	}
}

func (s *Service) SetRefreshInterval(ctx context.Context, sec int) error {
	if s.settings == nil {
		return nil
	}
	return s.settings.Set(ctx, settings.RefreshIntervalKey, strconv.Itoa(sec))
}

func (s *Service) SetStatusRefreshMode(ctx context.Context, mode string) error {
	if s.settings == nil {
		return nil
	}
	return s.settings.Set(ctx, settings.StatusRefreshModeKey, mode)
}

// peerMappingTTL bounds how long a peer->IP association from the hbbs logs
// is trusted without reconfirmation (presence.sh reports on a 300s rolling
// window; twice that here for sampler-skew margin).
const peerMappingTTL = 600 * time.Second

func (s *Service) readPresence() *presenceSnapshot {
	if s.presencePath == "" {
		return nil
	}
	data, err := os.ReadFile(s.presencePath)
	if err != nil {
		s.logger.Warn("Failed to read presence file", zap.Error(err))
		return nil
	}
	var snap presenceSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		s.logger.Warn("Failed to parse presence file", zap.Error(err))
		return nil
	}
	if time.Now().Unix()-snap.Ts > int64(presenceTimeout.Seconds()) {
		s.logger.Warn("Presence snapshot is stale", zap.Int64("ts", snap.Ts))
		return nil
	}

	s.mu.Lock()
	nowUnix := time.Now().Unix()
	for decID, ips := range snap.PeerIPs {
		if len(ips) == 0 {
			continue
		}
		hexID := strings.ToUpper(hex.EncodeToString([]byte(decID)))
		s.peerPrimary[hexID] = strings.TrimPrefix(ips[0], "::ffff:")
		s.peerPrimaryTs[hexID] = nowUnix
	}
	for hexID, ts := range s.peerPrimaryTs {
		if nowUnix-ts > int64(peerMappingTTL.Seconds()) {
			delete(s.peerPrimaryTs, hexID)
			delete(s.peerPrimary, hexID)
		}
	}
	s.mu.Unlock()

	return &snap
}

// sqlStorePeerID hex-encodes the decimal peer id string before persisting it.
// normalPeerID reverses that so clients see the real RustDesk ID (e.g. "1234567").
func normalPeerID(p string) string {
	if p == "" || len(p)%2 != 0 {
		return p
	}
	b, err := hex.DecodeString(p)
	if err != nil {
		return p
	}
	return string(b)
}

// sqlArg renders a pgx positional placeholder ($1, $2, ...) for an argument
// index. Built with strconv so it keeps working beyond nine arguments.
func sqlArg(i int) string {
	return "$" + strconv.Itoa(i)
}

func peerIPFromInfo(info string) string {
	var m struct {
		IP string `json:"ip"`
	}
	if err := json.Unmarshal([]byte(info), &m); err != nil || m.IP == "" {
		return ""
	}
	return strings.TrimPrefix(m.IP, "::ffff:")
}

// deviceAliases returns peer_id (hex) -> alias for every known device.
func (s *Service) deviceAliases(ctx context.Context) map[string]string {
	out := map[string]string{}
	rows, err := s.pool.Query(ctx, `SELECT peer_id, alias FROM devices WHERE deleted_at IS NULL AND alias IS NOT NULL AND alias <> ''`)
	if err != nil {
		s.logger.Warn("Failed to load device aliases", zap.Error(err))
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id, alias string
		if err := rows.Scan(&id, &alias); err != nil {
			continue
		}
		out[id] = alias
	}
	return out
}

// enrichConns maps raw presence connections (ip, port) to devices and returns
// the enriched list plus the number of unique devices involved (falling back
// to unique IPs when a device cannot be identified). Must be called with s.mu held.
func (s *Service) enrichConns(raw []presenceConn, aliases map[string]string) ([]StatusConn, int) {
	peerByIP := map[string][]string{}
	for hexID, ip := range s.peerPrimary {
		if ip != "" {
			peerByIP[ip] = append(peerByIP[ip], hexID)
		}
	}
	for hexID, ip := range s.peerInfoIP {
		if ip != "" {
			peerByIP[ip] = append(peerByIP[ip], hexID)
		}
	}

	seen := map[string]struct{}{}
	count := 0
	out := make([]StatusConn, 0, len(raw))
	for _, rc := range raw {
		conn := StatusConn{IP: rc.IP, Port: rc.Port}
		localSeen := map[string]struct{}{}
		for _, hexID := range peerByIP[rc.IP] {
			id := normalPeerID(hexID)
			if _, ok := localSeen[id]; ok {
				continue
			}
			localSeen[id] = struct{}{}
			if conn.PeerID == "" {
				conn.PeerID = id
			}
			if conn.Alias == "" {
				conn.Alias = aliases[hexID]
			}
		}
		out = append(out, conn)
		key := conn.PeerID
		if key == "" {
			key = "ip:" + conn.IP
		}
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			count++
		}
	}
	return out, count
}

// enrichConnsSnapshot is the lock-free twin of enrichConns for callers that
// already snapshotted the peer maps (e.g. GetServerStatus serving HTTP while
// the watcher keeps writing). online carries the last computed flags so rows
// whose attributed peer is offline can be dimmed; lastSeen orders candidates
// sharing one IP so N sockets get N distinct peers (most-recently-active
// first) instead of a random first match per row; the count covers only
// sockets with recent traffic.
func (s *Service) enrichConnsSnapshot(raw []presenceConn, aliases, peerPrimary, peerInfo map[string]string, online map[string]bool, lastSeen map[string]time.Time) ([]StatusConn, int) {
	peerByIP := map[string][]string{}
	seenIP := map[string]map[string]bool{}
	addCand := func(ip, hexID string) {
		if ip == "" {
			return
		}
		if seenIP[ip] == nil {
			seenIP[ip] = map[string]bool{}
		}
		if !seenIP[ip][hexID] {
			seenIP[ip][hexID] = true
			peerByIP[ip] = append(peerByIP[ip], hexID)
		}
	}
	for hexID, ip := range peerPrimary {
		addCand(ip, hexID)
	}
	for hexID, ip := range peerInfo {
		addCand(ip, hexID)
	}

	// Distinct deterministic attribution per IP: most-recently-active
	// candidate takes the first socket, the next takes the second, and so
	// on; extra sockets repeat the top candidate. Ties break by hex id so
	// the rows never flap between ticks.
	assigned := make(map[int]string, len(raw))
	byIPIdx := map[string][]int{}
	for i, rc := range raw {
		byIPIdx[rc.IP] = append(byIPIdx[rc.IP], i)
	}
	for ip, idxs := range byIPIdx {
		cands := append([]string{}, peerByIP[ip]...)
		sort.Slice(cands, func(a, b int) bool {
			ta, tb := lastSeen[cands[a]], lastSeen[cands[b]]
			if ta.Equal(tb) {
				return cands[a] < cands[b]
			}
			return ta.After(tb)
		})
		for k, idx := range idxs {
			if len(cands) == 0 {
				break
			}
			if k < len(cands) {
				assigned[idx] = cands[k]
			} else {
				assigned[idx] = cands[0]
			}
		}
	}

	seen := map[string]struct{}{}
	count := 0
	out := make([]StatusConn, 0, len(raw))
	for i, rc := range raw {
		conn := StatusConn{IP: rc.IP, Port: rc.Port}
		active := connIsActive(rc.LastRcvMs)
		if hexID, ok := assigned[i]; ok {
			conn.PeerID = normalPeerID(hexID)
			conn.Alias = aliases[hexID]
			if on, seen := online[hexID]; seen && !on {
				conn.Stale = true
			}
		}
		if !active {
			conn.Stale = true
		}
		out = append(out, conn)
		if !active {
			continue
		}
		key := conn.PeerID
		if key == "" {
			key = "ip:" + conn.IP
		}
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			count++
		}
	}
	return out, count
}

// startOnlineWatcher is the light, high-frequency loop that keeps online /
// offline flags fresh and pushes an SSE snapshot. It only computes status in
// push mode; in poll mode it merely keeps the in-memory presence fresh so the
// Server card stays accurate between discovery ticks.
func (s *Service) startOnlineWatcher(ctx context.Context) {
	ticker := time.NewTicker(onlineWatcherInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tickStatus(ctx)
		}
	}
}

func (s *Service) tickStatus(ctx context.Context) {
	snap := s.readPresence()
	if snap != nil {
		s.mu.Lock()
		s.lastPresence = snap
		s.mu.Unlock()
	}
	if s.statusRefreshMode() != settings.StatusRefreshModePush {
		return
	}

	known := s.fetchDevicePeerIDs(ctx)
	online := s.computeOnline(snap, known)
	s.applyHbbsVerdict(online, s.hbbsVerdict(ctx, known))
	s.applyStatus(ctx, online)
}

// syncDevices is the discovery loop. It always records every peer found in the
// hbbs peer table plus any peer observed in the presence logs so the devices
// table accumulates everyone who ever connected. It decouples peer discovery
// from presence freshness: only the online flags depend on a live snapshot.
func (s *Service) syncDevices(ctx context.Context) {
	if s.hbbDBPath == "" {
		return
	}

	snap := s.readPresence()
	if snap != nil {
		s.mu.Lock()
		s.lastPresence = snap
		s.mu.Unlock()
	}

	sqliteDB, err := sql.Open("sqlite3", s.hbbDBPath+"?mode=ro")
	if err != nil {
		s.logger.Warn("Failed to open hbbs SQLite", zap.Error(err))
		return
	}
	defer sqliteDB.Close()

	rows, err := sqliteDB.QueryContext(ctx, `
		SELECT id, info
		FROM peer
	`)
	if err != nil {
		s.logger.Warn("Failed to query hbbs peers", zap.Error(err))
		return
	}
	defer rows.Close()

	known := map[string]bool{}

	for rows.Next() {
		var peerID, infoStr string
		if err := rows.Scan(&peerID, &infoStr); err != nil {
			s.logger.Warn("Failed to scan peer", zap.Error(err))
			continue
		}
		hexID := strings.ToUpper(hex.EncodeToString([]byte(peerID)))
		known[hexID] = true
		if ip := peerIPFromInfo(infoStr); ip != "" {
			s.mu.Lock()
			s.peerInfoIP[hexID] = ip
			s.mu.Unlock()
		}
	}

	// Peers only seen in the presence logs (transient / not yet persisted by
	// hbbs) are recorded too so nothing that ever connected is missed.
	if snap != nil {
		for decID := range snap.PeerIPs {
			hexID := strings.ToUpper(hex.EncodeToString([]byte(decID)))
			known[hexID] = true
		}
	}

	// Persist every known peer (ON CONFLICT makes this idempotent), then
	// apply up-to-date online flags for anything that changed.
	for hexID := range known {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO devices (peer_id, online, updated_at)
			VALUES ($1, false, NOW())
			ON CONFLICT (peer_id) DO NOTHING
		`, hexID); err != nil {
			s.logger.Warn("Failed to insert device", zap.Error(err), zap.String("peer_id", hexID))
		}
	}

	online := s.computeOnline(snap, known)
	s.applyHbbsVerdict(online, s.hbbsVerdict(ctx, known))
	s.applyStatus(ctx, online)
}

// fetchDevicePeerIDs returns all non-deleted devices stored in the admin DB so
// the watcher can flip stale entries offline even when they are no longer in
// the hbbs peer table.
func (s *Service) fetchDevicePeerIDs(ctx context.Context) map[string]bool {
	known := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT peer_id FROM devices WHERE deleted_at IS NULL`)
	if err != nil {
		s.logger.Warn("Failed to query devices for status", zap.Error(err))
		return known
	}
	defer rows.Close()
	for rows.Next() {
		var hexID string
		if err := rows.Scan(&hexID); err != nil {
			continue
		}
		known[hexID] = true
	}
	return known
}

// hbbsVerdict queries hbbs for authoritative online flags, keyed by hex peer
// id to match the known set. Returns nil when hbbs is unreachable or the
// answer is unusable — the caller then falls back to socket detection.
func (s *Service) hbbsVerdict(ctx context.Context, known map[string]bool) map[string]bool {
	if s.hbbsAddr == "" {
		return nil
	}
	hexIDs := make([]string, 0, len(known))
	for hexID := range known {
		hexIDs = append(hexIDs, hexID)
	}
	decIDs := make([]string, 0, len(hexIDs))
	hexByDec := make(map[string]string, len(hexIDs))
	for _, hexID := range hexIDs {
		dec := normalPeerID(hexID)
		decIDs = append(decIDs, dec)
		hexByDec[dec] = hexID
	}
	flags, err := queryHbbsOnline(ctx, s.hbbsAddr, decIDs)
	if err != nil {
		s.logger.Warn("hbbs online query failed, using socket detection", zap.Error(err))
		return nil
	}
	out := make(map[string]bool, len(hexIDs))
	for dec, on := range flags {
		if hexID, ok := hexByDec[dec]; ok {
			out[hexID] = on
		}
	}
	return out
}

// applyHbbsVerdict overrides socket-based flags with the authoritative
// per-peer verdict (nil verdict = hbbs unreachable, keep socket result).
func (s *Service) applyHbbsVerdict(online map[string]bool, verdict map[string]bool) {
	if verdict == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for hexID, v := range verdict {
		online[hexID] = v
		if v {
			s.lastOnline[hexID] = now
			s.onlineSource[hexID] = "hbbs"
		} else {
			delete(s.onlineSource, hexID)
		}
	}
}

// computeOnline decides the online set for every known peer (true=online,
// false=offline) so transitions in both directions reach applyStatus. Live
// connections come from the hbbs/hbbr socket snapshot; each IP is resolved to
// the peers that may be behind it (primary peer IP from presence logs, falling
// back to the IP recorded at registration). When more peers share an IP than
// there are connections, only the most recently active stay online. A short
// grace keeps flags from flapping.
func (s *Service) computeOnline(snap *presenceSnapshot, known map[string]bool) map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	res := make(map[string]bool, len(known))
	for hexID := range known {
		res[hexID] = false
	}

	byIP := map[string][]string{}
	for hexID := range known {
		ip := s.peerPrimary[hexID]
		if ip == "" {
			ip = s.peerInfoIP[hexID]
		}
		if ip == "" {
			continue
		}
		byIP[ip] = append(byIP[ip], hexID)
	}

	// Number of live connections per IP. The socket snapshot is the definitive
	// source; the plain-list/count variants in presence.json exist for
	// compatibility with the panel API but are not used for online detection.
	// Only sockets that recently carried data count: silent leftovers of
	// powered-off PCs (no FIN sent, NAT keeps them ESTABLISHED) must not
	// prove anyone alive.
	avail := map[string]int{}
	if snap != nil {
		for _, c := range snap.HbbsConns {
			if connIsActive(c.LastRcvMs) {
				avail[c.IP]++
			}
		}
		for _, c := range snap.HbbrConns {
			if connIsActive(c.LastRcvMs) {
				avail[c.IP]++
			}
		}
	}

	now := time.Now()
	for ip, n := range avail {
		peers := byIP[ip]
		if n <= 0 {
			continue
		}
		sort.Slice(peers, func(i, j int) bool {
			return s.lastOnline[peers[i]].After(s.lastOnline[peers[j]])
		})
		if n >= len(peers) {
			for _, p := range peers {
				res[p] = true
				s.lastOnline[p] = now
				s.onlineSource[p] = "conn:" + ip
			}
		} else {
			// Ambiguous: fewer live sockets than peers behind one IP (shared
			// NAT). No data tells which peer owns the socket, so the pick is
			// flagged honestly instead of silently winning forever.
			for _, p := range peers[:n] {
				res[p] = true
				s.lastOnline[p] = now
				s.onlineSource[p] = "shared:" + ip
			}
		}
	}

	// Grace period so brief re-registrations don't cause flapping. Only peers
	// with a live connection refresh lastOnline above; a peer that is online
	// purely thanks to grace keeps its old timestamp, so its grace expires and
	// it falls offline once the connection is really gone.
	grace := s.offlineGrace()
	for hexID := range known {
		if res[hexID] {
			continue
		}
		if last := s.lastOnline[hexID]; !last.IsZero() && now.Sub(last) < grace {
			res[hexID] = true
			s.onlineSource[hexID] = "grace:" + last.Add(grace).UTC().Format(time.RFC3339)
		} else {
			delete(s.onlineSource, hexID)
		}
	}

	return res
}

// applyStatus writes changed flags to the DB and publishes an SSE snapshot
// when the online set actually changed.
func (s *Service) applyStatus(ctx context.Context, online map[string]bool) {
	s.mu.Lock()
	for hexID, isOn := range online {
		prev, seen := s.onlineState[hexID]
		if seen && prev == isOn {
			continue
		}
		s.onlineState[hexID] = isOn
		if _, err := s.pool.Exec(ctx, `
			UPDATE devices SET
				online = $1,
				deleted_at = CASE WHEN $1 THEN NULL ELSE deleted_at END,
				last_seen = CASE WHEN $1 THEN NOW() ELSE last_seen END,
				updated_at = NOW()
			WHERE peer_id = $2
		`, isOn, hexID); err != nil {
			s.logger.Warn("Failed to update device status", zap.Error(err), zap.String("peer_id", hexID))
		}
	}

	ids := make([]string, 0, len(online))
	for hexID, isOn := range online {
		if isOn {
			ids = append(ids, hexID)
		}
	}
	sort.Strings(ids)

	ev := StatusEvent{TS: time.Now().UTC(), Online: ids, Count: len(ids)}
	if s.lastStatus == nil || !sameOnlineSet(s.lastStatus.Online, ids) {
		s.lastStatus = &ev
		for ch := range s.subs {
			select {
			case ch <- ev:
			default:
			}
		}
	}
	s.mu.Unlock()
}

func sameOnlineSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *Service) subscribe() (chan StatusEvent, bool) {
	ch := make(chan StatusEvent, 16)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.subs) >= maxStatusSubscribers {
		return nil, false
	}
	s.subs[ch] = struct{}{}
	if s.lastStatus != nil {
		select {
		case ch <- *s.lastStatus:
		default:
		}
	}
	return ch, true
}

func (s *Service) unsubscribe(ch chan StatusEvent) {
	s.mu.Lock()
	delete(s.subs, ch)
	s.mu.Unlock()
}

// StreamDevices is the SSE endpoint: it pushes {online, online_count} snapshots
// so the panel can render device status near-instantly in push mode.
func (s *Service) StreamDevices(c *gin.Context) {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.String(http.StatusInternalServerError, "streaming unsupported")
		return
	}

	ch, ok := s.subscribe()
	if !ok {
		c.String(http.StatusServiceUnavailable, "too many stream subscribers")
		return
	}
	defer s.unsubscribe(ch)

	ctx := c.Request.Context()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(c.Writer, "data: %s\n\n", b)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprintln(c.Writer, ": ping")
			flusher.Flush()
		}
	}
}

func (s *Service) GetServerStatus(c *gin.Context) {
	// Snapshot presence and peer maps under the lock, then do the
	// (potentially slow) DB lookup outside of it so status watchers are
	// never blocked on I/O.
	s.mu.Lock()
	snap := s.lastPresence
	peerPrimary := make(map[string]string, len(s.peerPrimary))
	for k, v := range s.peerPrimary {
		peerPrimary[k] = v
	}
	peerInfo := make(map[string]string, len(s.peerInfoIP))
	for k, v := range s.peerInfoIP {
		peerInfo[k] = v
	}
	online := make(map[string]bool, len(s.onlineState))
	for k, v := range s.onlineState {
		online[k] = v
	}
	lastSeen := make(map[string]time.Time, len(s.lastOnline))
	for k, v := range s.lastOnline {
		lastSeen[k] = v
	}
	s.mu.Unlock()

	status := ServerStatus{}
	if snap != nil {
		status.HbbsListening = snap.HbbsListening
		status.HbbrListening = snap.HbbrListening
		status.RelayActive = len(snap.Hbbr) > 0
		status.HbbsClients = snap.Hbbs
		status.RelayClients = snap.Hbbr
		status.HbbsVersion = snap.HbbsVersion
		status.HbbrVersion = snap.HbbrVersion
		status.UpdatedAt = time.Unix(snap.Ts, 0)

		aliases := s.deviceAliases(c.Request.Context())
		status.HbbsConns, status.HbbsDevices = s.enrichConnsSnapshot(snap.HbbsConns, aliases, peerPrimary, peerInfo, online, lastSeen)
		status.HbbrConns, status.HbbrDevices = s.enrichConnsSnapshot(snap.HbbrConns, aliases, peerPrimary, peerInfo, online, lastSeen)
	}
	c.JSON(200, status)
}

// EnsurePasswordSchema adds the password columns to an already-seeded Postgres
// volume (the docker-entrypoint migrations only run on first init). It runs
// once at bootstrap; schema writes are deliberately not performed on request
// hot paths, where a read-only database role would fail on every GET.
func (s *Service) EnsurePasswordSchema(ctx context.Context) error {
	var err error
	s.schemaOnce.Do(func() {
		_, err = s.pool.Exec(ctx, `
			ALTER TABLE devices
				ADD COLUMN IF NOT EXISTS password_enc TEXT,
				ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ
		`)
		if err == nil {
			_, err = s.pool.Exec(ctx, `CREATE INDEX IF NOT EXISTS idx_devices_password ON devices (id) WHERE password_enc IS NOT NULL`)
		}
	})
	return err
}

// EnsurePeerInfoSchema adds the PeerInfo snapshot columns to an
// already-seeded Postgres volume (the docker-entrypoint migrations only run
// on first init). Same once-at-bootstrap pattern as EnsurePasswordSchema.
func (s *Service) EnsurePeerInfoSchema(ctx context.Context) error {
	var err error
	s.peerinfoSchemaOnce.Do(func() {
		_, err = s.pool.Exec(ctx, `
			ALTER TABLE devices
				ADD COLUMN IF NOT EXISTS hostname TEXT,
				ADD COLUMN IF NOT EXISTS username TEXT,
				ADD COLUMN IF NOT EXISTS platform TEXT,
				ADD COLUMN IF NOT EXISTS host_version TEXT,
				ADD COLUMN IF NOT EXISTS displays JSONB,
				ADD COLUMN IF NOT EXISTS peerinfo_updated_at TIMESTAMPTZ
		`)
	})
	return err
}

func (s *Service) GetDevicePassword(c *gin.Context) {
	id, ok := deviceIDParam(c)
	if !ok {
		return
	}

	var enc sql.NullString
	err := s.pool.QueryRow(c.Request.Context(),
		`SELECT password_enc FROM devices WHERE id = $1 AND deleted_at IS NULL`, id).Scan(&enc)
	if err != nil {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	if !enc.Valid || enc.String == "" {
		c.JSON(404, gin.H{"error": "no saved password"})
		return
	}

	plain, err := s.decryptPassword(enc.String)
	if err != nil {
		s.logger.Warn("device password decrypt failed (encryption key changed?)", zap.Error(err))
		c.JSON(500, gin.H{"error": "saved password cannot be decrypted (encryption key changed?)"})
		return
	}
	c.JSON(200, gin.H{"password": plain})
}

func (s *Service) SaveDevicePassword(c *gin.Context) {
	id, ok := deviceIDParam(c)
	if !ok {
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request body"})
		return
	}
	if req.Password == "" || len(req.Password) > 255 {
		c.JSON(400, gin.H{"error": "password must be non-empty and at most 255 chars"})
		return
	}

	enc, err := encryptSecret(s.encSecret, req.Password)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to encrypt password"})
		return
	}

	result, err := s.pool.Exec(c.Request.Context(), `
		UPDATE devices SET
			password_enc = $1,
			password_updated_at = NOW(),
			updated_at = NOW()
		WHERE id = $2 AND deleted_at IS NULL
	`, enc, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to save password"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	c.JSON(200, gin.H{"message": "password saved"})
}

func (s *Service) DeleteDevicePassword(c *gin.Context) {
	id, ok := deviceIDParam(c)
	if !ok {
		return
	}

	result, err := s.pool.Exec(c.Request.Context(), `
		UPDATE devices SET password_enc = NULL, password_updated_at = NULL, updated_at = NOW()
		WHERE id = $1 AND deleted_at IS NULL
	`, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to clear password"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	c.JSON(200, gin.H{"message": "password cleared"})
}

func deviceIDParam(c *gin.Context) (uuid.UUID, bool) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid device ID"})
		return uuid.Nil, false
	}
	return id, true
}

// GetPeerPassword resolves a user-facing (decimal) peer id to its stored
// password so the web client can pre-fill it on the /control/:id page.
func (s *Service) GetPeerPassword(c *gin.Context) {
	peerID := strings.TrimSpace(c.Param("peerId"))
	if peerID == "" {
		c.JSON(400, gin.H{"error": "peer id is required"})
		return
	}
	hexID := strings.ToUpper(hex.EncodeToString([]byte(peerID)))

	var enc sql.NullString
	err := s.pool.QueryRow(c.Request.Context(),
		`SELECT password_enc FROM devices WHERE peer_id = $1 AND deleted_at IS NULL`, hexID).Scan(&enc)
	if err != nil {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	if !enc.Valid || enc.String == "" {
		c.JSON(404, gin.H{"error": "no saved password"})
		return
	}

	plain, err := s.decryptPassword(enc.String)
	if err != nil {
		s.logger.Warn("peer password decrypt failed (encryption key changed?)", zap.Error(err))
		c.JSON(500, gin.H{"error": "saved password cannot be decrypted (encryption key changed?)"})
		return
	}
	c.JSON(200, gin.H{"password": plain})
}

// SavePeerPassword stores (or replaces) the saved password for a uer-facing
// peer id. Used by the "remember password" checkbox on the control page.
func (s *Service) SavePeerPassword(c *gin.Context) {
	peerID := strings.TrimSpace(c.Param("peerId"))
	if peerID == "" {
		c.JSON(400, gin.H{"error": "peer id is required"})
		return
	}
	hexID := strings.ToUpper(hex.EncodeToString([]byte(peerID)))

	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request body"})
		return
	}
	if req.Password == "" || len(req.Password) > 255 {
		c.JSON(400, gin.H{"error": "password must be non-empty and at most 255 chars"})
		return
	}

	enc, err := encryptSecret(s.encSecret, req.Password)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to encrypt password"})
		return
	}

	result, err := s.pool.Exec(c.Request.Context(), `
		UPDATE devices SET
			password_enc = $1,
			password_updated_at = NOW(),
			updated_at = NOW()
		WHERE peer_id = $2 AND deleted_at IS NULL
	`, enc, hexID)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to save password"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	c.JSON(200, gin.H{"message": "password saved"})
}

// maxPeerInfoLen caps PeerInfo snapshot strings stored via the panel.
const maxPeerInfoLen = 128

// UpdatePeerInfo stores the last-known PeerInfo snapshot for a user-facing
// peer id. Called by the web client once per session on login OK (PeerInfo
// only exists inside a live encrypted session, so the panel can only ever
// snapshot it, never poll it).
func (s *Service) UpdatePeerInfo(c *gin.Context) {
	peerID := strings.TrimSpace(c.Param("peerId"))
	if peerID == "" {
		c.JSON(400, gin.H{"error": "peer id is required"})
		return
	}
	hexID := strings.ToUpper(hex.EncodeToString([]byte(peerID)))

	var req UpdatePeerInfoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request body"})
		return
	}
	for _, v := range []*string{req.Hostname, req.Username, req.Platform, req.HostVersion} {
		if v != nil && len(*v) > maxPeerInfoLen {
			c.JSON(400, gin.H{"error": "peerinfo field is too long (max 128 characters)"})
			return
		}
	}
	if len(req.Displays) > 16 {
		c.JSON(400, gin.H{"error": "too many displays (max 16)"})
		return
	}
	for _, d := range req.Displays {
		if err := validatePeerInfoDisplay(d); err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
	}
	displaysJSON, err := json.Marshal(req.Displays)
	if err != nil || string(displaysJSON) == "null" {
		displaysJSON = []byte("[]")
		err = nil
	}

	result, err := s.pool.Exec(c.Request.Context(), `
		UPDATE devices SET
			hostname = $1,
			username = $2,
			platform = $3,
			host_version = $4,
			displays = $5,
			peerinfo_updated_at = NOW(),
			updated_at = NOW()
		WHERE peer_id = $6 AND deleted_at IS NULL
	`, nullStr(req.Hostname), nullStr(req.Username), nullStr(req.Platform), nullStr(req.HostVersion), string(displaysJSON), hexID)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to save peer info"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}
	c.JSON(200, gin.H{"message": "peer info saved"})
}

func nullStr(s *string) interface{} {
	if s == nil {
		return nil
	}
	return *s
}

func validatePeerInfoDisplay(d PeerInfoDisplay) error {
	if len(d.Name) > maxPeerInfoLen {
		return errors.New("invalid display entry")
	}
	if d.Width < 1 || d.Width > 16384 || d.Height < 1 || d.Height > 16384 {
		return errors.New("invalid display entry")
	}
	return nil
}

func (s *Service) ListDevices(c *gin.Context) {
	var req ListDevicesRequest
	if err := c.ShouldBindQuery(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	page := req.Page
	if page < 1 {
		page = 1
	}
	limit := req.Limit
	if limit < 1 || limit > 100 {
		limit = 20
	}
	offset := (page - 1) * limit

	query := `
		SELECT id, peer_id, alias, pinned, deleted_at, last_seen, online,
		       password_enc IS NOT NULL AND password_enc <> '' AS password_saved,
		       created_at, updated_at,
		       hostname, username, platform, host_version,
		       displays::text, peerinfo_updated_at
		FROM devices
		WHERE deleted_at IS NULL
	`
	args := []interface{}{}
	argIdx := 1

	if req.Search != "" {
		// First condition: placeholders in the clause start at $1.
		clause, sargs := searchClauses(req.Search, req.Fields, req.Ops)
		query += " AND " + clause
		args = append(args, sargs...)
		argIdx += len(sargs)
	}

	if req.Pinned != nil {
		query += " AND pinned = " + sqlArg(argIdx)
		args = append(args, *req.Pinned)
		argIdx++
	}

	if req.Online != nil {
		query += " AND online = " + sqlArg(argIdx)
		args = append(args, *req.Online)
		argIdx++
	}

	// Count total
	countQuery := "SELECT COUNT(*)" + query[strings.Index(query, "FROM devices"):]
	var total int64
	err := s.pool.QueryRow(c.Request.Context(), countQuery, args...).Scan(&total)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to count devices"})
		return
	}

	query += " ORDER BY pinned DESC, last_seen DESC NULLS LAST LIMIT " + sqlArg(argIdx) + " OFFSET " + sqlArg(argIdx+1)
	args = append(args, limit, offset)

	rows, err := s.pool.Query(c.Request.Context(), query, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to list devices"})
		return
	}
	defer rows.Close()

	var devices []Device = []Device{}
	for rows.Next() {
		var d Device
		var alias sql.NullString
		var deletedAt sql.NullTime
		var lastSeen sql.NullTime
		var hostname, username, platform, hostVersion, displays sql.NullString
		var peerinfoUpdatedAt sql.NullTime
		if err := rows.Scan(&d.ID, &d.PeerID, &alias, &d.Pinned, &deletedAt, &lastSeen, &d.Online, &d.PasswordSaved, &d.CreatedAt, &d.UpdatedAt, &hostname, &username, &platform, &hostVersion, &displays, &peerinfoUpdatedAt); err != nil {
			c.JSON(500, gin.H{"error": "failed to scan device"})
			return
		}
		if alias.Valid {
			d.Alias = &alias.String
		}
		if hostname.Valid {
			d.Hostname = &hostname.String
		}
		if username.Valid {
			d.Username = &username.String
		}
		if platform.Valid {
			d.Platform = &platform.String
		}
		if hostVersion.Valid {
			d.HostVersion = &hostVersion.String
		}
		if displays.Valid {
			d.Displays = &displays.String
		}
		if peerinfoUpdatedAt.Valid {
			d.PeerinfoUpdatedAt = &peerinfoUpdatedAt.Time
		}
		if deletedAt.Valid {
			d.DeletedAt = &deletedAt.Time
		}
		if lastSeen.Valid {
			d.LastSeen = &lastSeen.Time
		}
		// Diagnostic source is attached only while the DB flag says online;
		// after a backend restart the map is empty and the source is honestly
		// unknown until the next tick recomputes it.
		if d.Online {
			s.mu.Lock()
			src, ok := s.onlineSource[d.PeerID]
			s.mu.Unlock()
			if ok {
				d.OnlineSource = &src
			}
		}
		d.PeerID = normalPeerID(d.PeerID)
		devices = append(devices, d)
	}

	c.JSON(200, ListDevicesResponse{
		Items: devices,
		Total: total,
		Page:  page,
		Limit: limit,
	})
}

func (s *Service) UpdateDevice(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid device ID"})
		return
	}

	var req UpdateDeviceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	setParts := []string{}
	args := []interface{}{}
	argIdx := 1

	if req.Alias != nil {
		if len(*req.Alias) > maxAliasLen {
			c.JSON(400, gin.H{"error": "alias is too long (max 64 characters)"})
			return
		}
		setParts = append(setParts, "alias = "+sqlArg(argIdx))
		args = append(args, *req.Alias)
		argIdx++
	}
	if req.Pinned != nil {
		setParts = append(setParts, "pinned = "+sqlArg(argIdx))
		args = append(args, *req.Pinned)
		argIdx++
	}

	if len(setParts) == 0 {
		c.JSON(400, gin.H{"error": "no fields to update"})
		return
	}

	setParts = append(setParts, "updated_at = NOW()")
	query := "UPDATE devices SET " + strings.Join(setParts, ", ") + " WHERE id = " + sqlArg(argIdx) + " AND deleted_at IS NULL"
	args = append(args, id)

	result, err := s.pool.Exec(c.Request.Context(), query, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to update device"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}

	c.JSON(200, gin.H{"message": "device updated"})
}

func (s *Service) DeleteDevice(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid device ID"})
		return
	}

	result, err := s.pool.Exec(c.Request.Context(), `
		UPDATE devices SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL
	`, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to delete device"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "device not found"})
		return
	}

	c.JSON(200, gin.H{"message": "device deleted"})
}
