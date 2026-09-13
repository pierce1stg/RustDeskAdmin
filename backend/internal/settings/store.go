package settings

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const (
	// RefreshIntervalKey is the row key for the device status sync interval.
	RefreshIntervalKey = "device_status_refresh_interval"
	// DefaultRefreshInterval in seconds.
	DefaultRefreshInterval = 30
	MinRefreshInterval     = 10
	MaxRefreshInterval     = 300

	// StatusRefreshModeKey selects how device online/offline state is
	// delivered to the panel: "push" (SSE watcher, near-instant) or "poll"
	// (refetch on the refresh interval timer).
	StatusRefreshModeKey     = "status_update_mode"
	StatusRefreshModePush    = "push"
	StatusRefreshModePoll    = "poll"
	DefaultStatusRefreshMode = StatusRefreshModePush

	// AdminUsernameKey / AdminPasswordHashKey store the admin credentials
	// (username + bcrypt hash). Seeded on first start, changeable from the UI.
	AdminUsernameKey     = "admin_username"
	AdminPasswordHashKey = "admin_password_hash"
	DefaultAdminUsername = "admin"
	DefaultAdminPassword = "admin"

	// Server info keys. Auto-detected values (hbbs data dir, env DOMAIN,
	// stack default ports) are shown as-is; a non-empty override here is used
	// instead and flagged as "manual" in the UI.
	ServerDisplayAddressKey = "server_display_address"
	ServerRelayAddressKey   = "server_relay_address"
	ServerApiKey            = "server_api"
	ServerIDPortKey         = "server_id_port"
	ServerRelayPortKey      = "server_relay_port"
	ServerWSPortKey         = "server_ws_port"
	ServerPublicKeyKey      = "server_public_key"
	DefaultIDPort           = "21116"
	DefaultRelayPort        = "21117"
	DefaultWSPort           = "21118"

	// Auth session token TTLs. Stored in the settings table so the admin
	// panel can retune them; env vars seed the first-boot defaults only.
	AccessTokenTTLKey          = "auth_access_token_ttl_minutes"
	RefreshTokenTTLKey         = "auth_refresh_token_ttl_days"
	DefaultAccessTokenTTLMin   = 60
	DefaultRefreshTokenTTLDays = 7
	MinAccessTokenTTLMin       = 5
	MaxAccessTokenTTLMin       = 10080 // 7 days in minutes
	MinRefreshTokenTTLDays     = 1
	MaxRefreshTokenTTLDays     = 365
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Get(ctx context.Context, key, def string) (string, error) {
	var value string
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = $1`, key,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return def, nil
	}
	if err != nil {
		return def, err
	}
	return value, nil
}

func (s *Store) Set(ctx context.Context, key, value string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO settings (key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET
			value = EXCLUDED.value,
			updated_at = NOW()
	`, key, value)
	return err
}

// EnsureDefaults seeds first-boot defaults for every tunable setting.
// Existing rows are never overwritten. Env values act as "Block B" of the
// .env template: they only apply on the very first start, afterwards the
// admin panel (settings table) is the single source of truth.
func (s *Store) EnsureDefaults(ctx context.Context) error {
	adminUser := envOr("ADMIN_USERNAME", DefaultAdminUsername)
	adminPass := envOr("ADMIN_PASSWORD", DefaultAdminPassword)
	hash, err := bcrypt.GenerateFromPassword([]byte(adminPass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO settings (key, value)
		VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12), ($13, $14), ($15, $16), ($17, $18), ($19, $20), ($21, $22), ($23, $24), ($25, $26)
		ON CONFLICT (key) DO NOTHING
	`,
		AdminUsernameKey, adminUser,
		AdminPasswordHashKey, string(hash),
		RefreshIntervalKey, envOr("STATUS_REFRESH_INTERVAL", strconv.Itoa(DefaultRefreshInterval)),
		StatusRefreshModeKey, envOr("STATUS_REFRESH_MODE", DefaultStatusRefreshMode),
		ServerDisplayAddressKey, os.Getenv("SERVER_DISPLAY_ADDRESS"),
		ServerRelayAddressKey, os.Getenv("RELAY_ADDRESS"),
		ServerApiKey, os.Getenv("RUSTDESK_API_SERVER"),
		ServerIDPortKey, envOr("RUSTDESK_ID_PORT", DefaultIDPort),
		ServerRelayPortKey, envOr("RUSTDESK_RELAY_PORT", DefaultRelayPort),
		ServerWSPortKey, envOr("RUSTDESK_WS_PORT", DefaultWSPort),
		ServerPublicKeyKey, os.Getenv("RUSTDESK_PUBLIC_KEY"),
		AccessTokenTTLKey, envOr("ACCESS_TOKEN_TTL_MINUTES", strconv.Itoa(DefaultAccessTokenTTLMin)),
		RefreshTokenTTLKey, envOr("REFRESH_TOKEN_TTL_DAYS", strconv.Itoa(DefaultRefreshTokenTTLDays)),
	); err != nil {
		return err
	}

	return nil
}

func (s *Store) GetRefreshInterval(ctx context.Context) int {
	raw, err := s.Get(ctx, RefreshIntervalKey, strconv.Itoa(DefaultRefreshInterval))
	if err != nil {
		return DefaultRefreshInterval
	}
	sec, err := strconv.Atoi(raw)
	if err != nil {
		return DefaultRefreshInterval
	}
	return clampInterval(sec)
}

// ValidRefreshMode reports whether v is an accepted status refresh mode.
func ValidRefreshMode(v string) bool {
	return v == StatusRefreshModePush || v == StatusRefreshModePoll
}

func (s *Store) GetStatusRefreshMode(ctx context.Context) string {
	raw, err := s.Get(ctx, StatusRefreshModeKey, DefaultStatusRefreshMode)
	if err != nil || !ValidRefreshMode(raw) {
		return DefaultStatusRefreshMode
	}
	return raw
}

// AccessTokenTTLMinutes returns the auth access-token lifetime in minutes
// (clamped between MinAccessTokenTTLMin and MaxAccessTokenTTLMin).
func (s *Store) AccessTokenTTLMinutes(ctx context.Context) int {
	raw, err := s.Get(ctx, AccessTokenTTLKey, strconv.Itoa(DefaultAccessTokenTTLMin))
	if err != nil {
		return DefaultAccessTokenTTLMin
	}
	min, err := strconv.Atoi(raw)
	if err != nil {
		return DefaultAccessTokenTTLMin
	}
	return clampInt(min, MinAccessTokenTTLMin, MaxAccessTokenTTLMin)
}

// RefreshTokenTTLDays returns the auth refresh-token lifetime in days
// (clamped between MinRefreshTokenTTLDays and MaxRefreshTokenTTLDays).
func (s *Store) RefreshTokenTTLDays(ctx context.Context) int {
	raw, err := s.Get(ctx, RefreshTokenTTLKey, strconv.Itoa(DefaultRefreshTokenTTLDays))
	if err != nil {
		return DefaultRefreshTokenTTLDays
	}
	days, err := strconv.Atoi(raw)
	if err != nil {
		return DefaultRefreshTokenTTLDays
	}
	return clampInt(days, MinRefreshTokenTTLDays, MaxRefreshTokenTTLDays)
}

func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func clampInterval(sec int) int {
	if sec < MinRefreshInterval {
		return MinRefreshInterval
	}
	if sec > MaxRefreshInterval {
		return MaxRefreshInterval
	}
	return sec
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
