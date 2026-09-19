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

	// Web client connection defaults. The admin panel edits these; they are
	// returned by GET /settings and applied as the initial quality/fps/codec
	// of every browser-based session (the user can still override per session).
	WebClientQualityKey     = "web_client_quality"
	WebClientFPSKey         = "web_client_fps"
	WebClientCodecKey       = "web_client_codec"
	DefaultWebClientQuality = 3
	DefaultWebClientFPS     = 30
	DefaultWebClientCodec   = "auto"
	MinWebClientFPS         = 1
	MaxWebClientFPS         = 240

	// Session-chat system messages. Each has an enable flag so the greeting
	// and the close notice toggle independently; empty text sends nothing.
	WebClientChatGreetingKey        = "web_client_chat_greeting"
	WebClientChatGreetingEnabledKey = "web_client_chat_greeting_enabled"
	WebClientChatCloseKey           = "web_client_chat_close"
	WebClientChatCloseEnabledKey    = "web_client_chat_close_enabled"
	DefaultWebClientChatGreeting    = "Hello! How can I help you?"
	DefaultWebClientChatClose       = "The operator has closed the chat."
	MaxWebClientChatText            = 2000 // runes, matches the wire cap

	// More web-client session defaults (admin panel edits these; the
	// browser applies them once per session unless the user overrides).
	WebClientRenderScaleKey     = "web_client_render_scale"
	WebClientCursorKey          = "web_client_cursor"
	WebClientInputModeKey       = "web_client_input_mode"
	DefaultWebClientRenderScale = "auto"
	DefaultWebClientCursor      = "false"
	DefaultWebClientInputMode   = "auto"

	// Display name this panel's web client announces to hosts
	// (LoginRequest.my_name; the host shows it in its session dialog).
	WebClientNameKey      = "web_client_name"
	DefaultWebClientName  = "Web Browser"
	MaxWebClientNameRunes = 64
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
		VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12), ($13, $14), ($15, $16), ($17, $18), ($19, $20), ($21, $22), ($23, $24), ($25, $26), ($27, $28), ($29, $30), ($31, $32), ($33, $34), ($35, $36), ($37, $38), ($39, $40), ($41, $42), ($43, $44), ($45, $46), ($47, $48)
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
		WebClientQualityKey, envOr("WEB_CLIENT_QUALITY", strconv.Itoa(DefaultWebClientQuality)),
		WebClientFPSKey, envOr("WEB_CLIENT_FPS", strconv.Itoa(DefaultWebClientFPS)),
		WebClientCodecKey, envOr("WEB_CLIENT_CODEC", DefaultWebClientCodec),
		WebClientChatGreetingKey, envOr("WEB_CLIENT_CHAT_GREETING", DefaultWebClientChatGreeting),
		WebClientChatGreetingEnabledKey, envOr("WEB_CLIENT_CHAT_GREETING_ENABLED", "true"),
		WebClientChatCloseKey, envOr("WEB_CLIENT_CHAT_CLOSE", DefaultWebClientChatClose),
		WebClientChatCloseEnabledKey, envOr("WEB_CLIENT_CHAT_CLOSE_ENABLED", "true"),
		WebClientRenderScaleKey, envOr("WEB_CLIENT_RENDER_SCALE", DefaultWebClientRenderScale),
		WebClientCursorKey, envOr("WEB_CLIENT_CURSOR", DefaultWebClientCursor),
		WebClientInputModeKey, envOr("WEB_CLIENT_INPUT_MODE", DefaultWebClientInputMode),
		WebClientNameKey, envOr("WEB_CLIENT_NAME", DefaultWebClientName),
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

// WebClientQuality returns the default web-client ImageQuality enum value
// (0 = Auto, 2 = Low, 3 = Balanced, 4 = Best), sanitized.
func (s *Store) WebClientQuality(ctx context.Context) int {
	raw, err := s.Get(ctx, WebClientQualityKey, strconv.Itoa(DefaultWebClientQuality))
	if err != nil {
		return DefaultWebClientQuality
	}
	q, err := strconv.Atoi(raw)
	if err != nil {
		return DefaultWebClientQuality
	}
	if q == 0 || q == 2 || q == 3 || q == 4 {
		return q
	}
	return DefaultWebClientQuality
}

// WebClientFPS returns the default web-client frame rate, clamped.
func (s *Store) WebClientFPS(ctx context.Context) int {
	raw, err := s.Get(ctx, WebClientFPSKey, strconv.Itoa(DefaultWebClientFPS))
	if err != nil {
		return DefaultWebClientFPS
	}
	fps, err := strconv.Atoi(raw)
	if err != nil {
		return DefaultWebClientFPS
	}
	return clampInt(fps, MinWebClientFPS, MaxWebClientFPS)
}

// WebClientCodec returns the default web-client codec preference ("auto" or a
// named codec), sanitized.
func (s *Store) WebClientCodec(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientCodecKey, DefaultWebClientCodec)
	if err != nil || !ValidWebClientCodec(raw) {
		return DefaultWebClientCodec
	}
	return raw
}

// ValidWebClientCodec reports whether v is an accepted codec preference.
func ValidWebClientCodec(v string) bool {
	switch v {
	case "auto", "vp8", "vp9", "av1":
		return true
	}
	return false
}

// ValidWebClientChatEnabled reports whether v is an accepted on/off flag.
func ValidWebClientChatEnabled(v string) bool {
	return v == "true" || v == "false"
}

// ValidWebClientChatText reports whether v fits the wire cap (runes, so
// Cyrillic counts as characters, not bytes).
func ValidWebClientChatText(v string) bool {
	return len([]rune(v)) <= MaxWebClientChatText
}

// WebClientChatGreeting returns the auto-greeting text (may be empty, which
// sends nothing).
func (s *Store) WebClientChatGreeting(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientChatGreetingKey, DefaultWebClientChatGreeting)
	if err != nil || !ValidWebClientChatText(raw) {
		return DefaultWebClientChatGreeting
	}
	return raw
}

// WebClientChatGreetingEnabled reports whether the auto-greeting sends.
func (s *Store) WebClientChatGreetingEnabled(ctx context.Context) bool {
	raw, err := s.Get(ctx, WebClientChatGreetingEnabledKey, "true")
	if err != nil || !ValidWebClientChatEnabled(raw) {
		return true
	}
	return raw == "true"
}

// WebClientChatClose returns the close-notice text (may be empty).
func (s *Store) WebClientChatClose(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientChatCloseKey, DefaultWebClientChatClose)
	if err != nil || !ValidWebClientChatText(raw) {
		return DefaultWebClientChatClose
	}
	return raw
}

// WebClientChatCloseEnabled reports whether the close notice sends.
func (s *Store) WebClientChatCloseEnabled(ctx context.Context) bool {
	raw, err := s.Get(ctx, WebClientChatCloseEnabledKey, "true")
	if err != nil || !ValidWebClientChatEnabled(raw) {
		return true
	}
	return raw == "true"
}

// ValidWebClientRenderScale reports whether v is an accepted render-scale cap.
func ValidWebClientRenderScale(v string) bool {
	switch v {
	case "auto", "original", "144p", "240p", "360p", "480p", "720p", "1080p", "1440p":
		return true
	}
	return false
}

// ValidWebClientInputMode reports whether v is an accepted input-mode default.
func ValidWebClientInputMode(v string) bool {
	switch v {
	case "auto", "touch", "pointer":
		return true
	}
	return false
}

// WebClientRenderScale returns the default render-scale cap, sanitized.
func (s *Store) WebClientRenderScale(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientRenderScaleKey, DefaultWebClientRenderScale)
	if err != nil || !ValidWebClientRenderScale(raw) {
		return DefaultWebClientRenderScale
	}
	return raw
}

// WebClientCursor reports whether the remote-cursor overlay defaults on.
func (s *Store) WebClientCursor(ctx context.Context) bool {
	raw, err := s.Get(ctx, WebClientCursorKey, DefaultWebClientCursor)
	if err != nil || !ValidWebClientChatEnabled(raw) {
		return false
	}
	return raw == "true"
}

// WebClientInputMode returns the default input mode ("auto" = device detect).
func (s *Store) WebClientInputMode(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientInputModeKey, DefaultWebClientInputMode)
	if err != nil || !ValidWebClientInputMode(raw) {
		return DefaultWebClientInputMode
	}
	return raw
}

// ValidWebClientName reports whether v fits the host dialog (1-64 runes).
func ValidWebClientName(v string) bool {
	n := len([]rune(v))
	return n >= 1 && n <= MaxWebClientNameRunes
}

// WebClientName returns the display name announced to hosts, sanitized.
func (s *Store) WebClientName(ctx context.Context) string {
	raw, err := s.Get(ctx, WebClientNameKey, DefaultWebClientName)
	if err != nil || !ValidWebClientName(raw) {
		return DefaultWebClientName
	}
	return raw
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
