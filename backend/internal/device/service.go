package device

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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
	logger       *zap.Logger
	settings     *settings.Store

	mu sync.Mutex

	lastPresence *presenceSnapshot

	// peerPrimary maps hex peer id -> current IP last observed in the hbbs
	// logs (presence peer_ips). peerInfoIP is the fallback recorded at
	// registration (peer.info) captured during discovery sync.
	peerPrimary map[string]string
	peerInfoIP  map[string]string

	// lastOnline keeps the last time each hex peer was seen online so a brief
	// gap (re-registration / presence tick miss) does not flap the flag.
	lastOnline map[string]time.Time

	// onlineState is the hex peer -> online flag as last written/published.
	onlineState map[string]bool

	refreshInt int

	subs       map[chan StatusEvent]struct{}
	lastStatus *StatusEvent
}

type presenceConn struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
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
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

type StatusConn struct {
	IP     string `json:"ip"`
	Port   int    `json:"port,omitempty"`
	PeerID string `json:"peer_id,omitempty"`
	Alias  string `json:"alias,omitempty"`
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
	Pinned *bool  `form:"pinned"`
	Online *bool  `form:"online"`
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

func NewService(pool *pgxpool.Pool, hbbDBPath, presencePath string, settingsStore *settings.Store, logger *zap.Logger) *Service {
	return &Service{
		pool:         pool,
		hbbDBPath:    hbbDBPath,
		presencePath: presencePath,
		logger:       logger,
		settings:     settingsStore,
		lastOnline:   make(map[string]time.Time),
		peerPrimary:  make(map[string]string),
		peerInfoIP:   make(map[string]string),
		onlineState:  make(map[string]bool),
		subs:         make(map[chan StatusEvent]struct{}),
		refreshInt:   settings.DefaultRefreshInterval,
	}
}

func (s *Service) refreshInterval() time.Duration {
	if s.settings == nil {
		return time.Duration(settings.DefaultRefreshInterval) * time.Second
	}
	sec := s.settings.GetRefreshInterval(context.Background())
	s.refreshInt = sec
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
	for decID, ips := range snap.PeerIPs {
		if len(ips) == 0 {
			continue
		}
		hexID := strings.ToUpper(hex.EncodeToString([]byte(decID)))
		s.peerPrimary[hexID] = strings.TrimPrefix(ips[0], "::ffff:")
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
	avail := map[string]int{}
	if snap != nil {
		for _, c := range snap.HbbsConns {
			avail[c.IP]++
		}
		for _, c := range snap.HbbrConns {
			avail[c.IP]++
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
			}
		} else {
			for _, p := range peers[:n] {
				res[p] = true
				s.lastOnline[p] = now
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

func (s *Service) subscribe() chan StatusEvent {
	ch := make(chan StatusEvent, 16)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	if s.lastStatus != nil {
		select {
		case ch <- *s.lastStatus:
		default:
		}
	}
	s.mu.Unlock()
	return ch
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

	ch := s.subscribe()
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
	s.mu.Lock()
	defer s.mu.Unlock()

	status := ServerStatus{}
	if s.lastPresence != nil {
		status.HbbsListening = s.lastPresence.HbbsListening
		status.HbbrListening = s.lastPresence.HbbrListening
		status.RelayActive = len(s.lastPresence.Hbbr) > 0
		status.HbbsClients = s.lastPresence.Hbbs
		status.RelayClients = s.lastPresence.Hbbr
		status.HbbsVersion = s.lastPresence.HbbsVersion
		status.HbbrVersion = s.lastPresence.HbbrVersion
		status.UpdatedAt = time.Unix(s.lastPresence.Ts, 0)

		ctx := c.Request.Context()
		aliases := s.deviceAliases(ctx)
		status.HbbsConns, status.HbbsDevices = s.enrichConns(s.lastPresence.HbbsConns, aliases)
		status.HbbrConns, status.HbbrDevices = s.enrichConns(s.lastPresence.HbbrConns, aliases)
	}
	c.JSON(200, status)
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
		SELECT id, peer_id, alias, pinned, deleted_at, last_seen, online, created_at, updated_at
		FROM devices
		WHERE deleted_at IS NULL
	`
	args := []interface{}{}
	argIdx := 1

	if req.Search != "" {
		query += " AND (alias ILIKE " + sqlArg(argIdx) + " OR peer_id ILIKE " + sqlArg(argIdx) + ")"
		args = append(args, "%"+req.Search+"%")
		argIdx++
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
	countQuery := strings.Replace(query, "SELECT id, peer_id, alias, pinned, deleted_at, last_seen, online, created_at, updated_at", "SELECT COUNT(*)", 1)
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
		if err := rows.Scan(&d.ID, &d.PeerID, &alias, &d.Pinned, &deletedAt, &lastSeen, &d.Online, &d.CreatedAt, &d.UpdatedAt); err != nil {
			c.JSON(500, gin.H{"error": "failed to scan device"})
			return
		}
		if alias.Valid {
			d.Alias = &alias.String
		}
		if deletedAt.Valid {
			d.DeletedAt = &deletedAt.Time
		}
		if lastSeen.Valid {
			d.LastSeen = &lastSeen.Time
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
