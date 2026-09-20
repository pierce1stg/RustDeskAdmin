package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"rustdesk-admin/internal/appversion"
	"rustdesk-admin/internal/auth"
	"rustdesk-admin/internal/device"
	"rustdesk-admin/internal/settings"
	"rustdesk-admin/internal/update"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

type Config struct {
	DatabaseURL        string
	JWTSecret          string
	JWTRefreshSecret   string
	DeviceSecret       string
	HBBDBPath          string
	HBBPresencePath    string
	HBBOnlineAddr      string
	ServerPort         string
	GinMode            string
	AllowServerUpdates bool
	AllowPanelUpdates  bool
	ScreenshotsDir     string
}

func main() {
	cfg := loadConfig()

	logger, _ := zap.NewProduction()
	defer logger.Sync()

	// Refuse to boot with placeholder secrets so a missing env var can never
	// result in forgeable tokens.
	if cfg.JWTSecret == "" || cfg.JWTSecret == "dev-secret-change-in-production" ||
		cfg.JWTRefreshSecret == "" || cfg.JWTRefreshSecret == "dev-refresh-secret-change-in-production" {
		logger.Fatal("JWT_SECRET and JWT_REFRESH_SECRET must be configured (set both in .env / environment)")
	}

	if cfg.GinMode == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("Failed to connect to database", zap.Error(err))
	}
	defer pool.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Sync goroutines (presence watcher, online transitions) live for the whole
	// process; they are cancelled before the HTTP server shuts down so no DB
	// writes race with pool.Close().
	syncCtx, syncCancel := context.WithCancel(context.Background())
	defer syncCancel()

	settingsStore := settings.NewStore(pool)

	if err := settingsStore.EnsureDefaults(ctx); err != nil {
		cancel()
		logger.Fatal("Failed to seed settings defaults", zap.Error(err))
	}

	authService := auth.NewService(cfg.JWTSecret, cfg.JWTRefreshSecret, pool, settingsStore)
	// DEVICE_SECRET is the dedicated at-rest encryption key for saved device
	// passwords. Empty keeps the legacy behavior (JWT secret) so existing
	// rows stay readable; the JWT value is passed as decrypt fallback.
	deviceSecret := cfg.DeviceSecret
	if deviceSecret == "" {
		deviceSecret = cfg.JWTSecret
	}
	deviceService := device.NewService(pool, cfg.HBBDBPath, cfg.HBBPresencePath, deviceSecret, settingsStore, logger, cfg.HBBOnlineAddr, cfg.JWTSecret)

	// Apply the device-password schema once at bootstrap instead of lazily on
	// request hot paths (a read-only DB role would fail every GET otherwise).
	if err := deviceService.EnsurePasswordSchema(ctx); err != nil {
		logger.Fatal("Failed to ensure device password schema", zap.Error(err))
	}
	// Same for the PeerInfo snapshot columns (migration 005 covers fresh
	// installs; this covers already-seeded volumes).
	if err := deviceService.EnsurePeerInfoSchema(ctx); err != nil {
		logger.Fatal("Failed to ensure device peerinfo schema", zap.Error(err))
	}

	updater := update.NewUpdater(cfg.HBBPresencePath, cfg.AllowServerUpdates, logger)
	panelUpdater := update.NewPanelUpdater(cfg.HBBPresencePath, cfg.AllowPanelUpdates, logger)

	if err := os.MkdirAll(cfg.ScreenshotsDir, 0o755); err != nil {
		logger.Warn("Failed to create screenshots directory", zap.Error(err))
	}

	go deviceService.StartSync(syncCtx)

	router := setupRouter(cfg, authService, deviceService, settingsStore, updater, panelUpdater, func(ctx context.Context) error {
		return pool.Ping(ctx)
	})

	srv := &http.Server{
		Addr:              ":" + cfg.ServerPort,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout is intentionally not set: the /devices/stream SSE
		// endpoint holds an open response for the whole session.
	}

	go func() {
		logger.Info("Starting server", zap.String("port", cfg.ServerPort))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("Server failed", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("Shutting down server...")

	// Stop background sync before draining HTTP so in-flight handlers never
	// touch a closed pool.
	syncCancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Fatal("Server forced to shutdown", zap.Error(err))
	}
	logger.Info("Server exited")
}

func loadConfig() Config {
	return Config{
		DatabaseURL:        getEnv("DATABASE_URL", "postgres://rustdesk:changeme@localhost:5432/rustdesk_admin?sslmode=disable"),
		JWTSecret:          getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		JWTRefreshSecret:   getEnv("JWT_REFRESH_SECRET", "dev-refresh-secret-change-in-production"),
		DeviceSecret:       getEnv("DEVICE_SECRET", ""),
		HBBDBPath:          getEnv("HBB_DB_PATH", "/data/rustdesk/db_v2.sqlite3"),
		HBBPresencePath:    getEnv("HBB_PRESENCE_PATH", "/var/run/presence.json"),
		HBBOnlineAddr:      getEnv("HBB_ONLINE_ADDR", "hbbs:21115"),
		ServerPort:         getEnv("SERVER_PORT", "8080"),
		GinMode:            getEnv("GIN_MODE", "debug"),
		AllowServerUpdates: getEnv("ALLOW_SERVER_UPDATE", "true") != "false",
		AllowPanelUpdates:  getEnv("ALLOW_PANEL_UPDATE", "true") != "false",
		ScreenshotsDir:     getEnv("SCREENSHOTS_DIR", "/screenshots"),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// limitRequestBody caps every request body so a public (non-proxied) port
// cannot be abused to stream unbounded payloads into ShouldBindJSON parsers.
func limitRequestBody(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}

var serverInfoSettingKeys = map[string]string{
	"address":       settings.ServerDisplayAddressKey,
	"relay_address": settings.ServerRelayAddressKey,
	"api_server":    settings.ServerApiKey,
	"id_port":       settings.ServerIDPortKey,
	"relay_port":    settings.ServerRelayPortKey,
	"ws_port":       settings.ServerWSPortKey,
	"public_key":    settings.ServerPublicKeyKey,
}

func serverInfoFieldJSON(info settings.ServerInfo, key string) interface{} {
	switch key {
	case "address":
		return info.Address
	case "relay_address":
		return info.RelayAddress
	case "api_server":
		return info.ApiServer
	case "id_port":
		return info.IDPort
	case "relay_port":
		return info.RelayPort
	case "ws_port":
		return info.WSPort
	case "public_key":
		return info.PublicKey
	}
	return nil
}

// validHost accepts a hostname, an IPv4 address, or an IPv6 address wrapped in
// square brackets (as the client's config parser expects IPv6). No scheme,
// path or port is allowed.
func validHostname(v string) bool {
	if len(v) == 0 || len(v) > 253 {
		return false
	}
	// IPv6 in brackets like [::1]
	if strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]") {
		addr := v[1 : len(v)-1]
		if net.ParseIP(addr) == nil {
			return false
		}
		return true
	}
	// Plain IP without brackets.
	if net.ParseIP(v) != nil {
		return true
	}
	if strings.HasPrefix(v, "-") || strings.HasPrefix(v, ".") || strings.HasPrefix(v, "_") {
		return false
	}
	if strings.HasSuffix(v, "-") || strings.HasSuffix(v, ".") {
		return false
	}
	if strings.Contains(v, "..") {
		return false
	}
	for _, label := range strings.Split(v, ".") {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' ||
				r >= 'A' && r <= 'Z' ||
				r >= '0' && r <= '9' ||
				r == '-' || r == '_') {
				return false
			}
		}
	}
	return true
}

func validServerPublicKey(v string) bool {
	decoded, err := base64.StdEncoding.DecodeString(v)
	return err == nil && len(decoded) == 32
}

// validAPIServer accepts a full http(s) URL with a host and no userinfo.
func validAPIServer(v string) bool {
	if strings.ContainsAny(v, " \t\r\n") {
		return false
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || u.User != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func setupRouter(cfg Config, authService *auth.Service, deviceService *device.Service, settingsStore *settings.Store, updater *update.Updater, panelUpdater *update.PanelUpdater, healthCheck func(ctx context.Context) error) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(gin.Logger())
	r.Use(limitRequestBody(16 << 20)) // 16 MiB cap (screenshot uploads are <= 10 MiB)
	// Trust only private-range proxies (docker networks, nginx) for
	// X-Forwarded-For. Direct public clients have their XFF ignored, so
	// ClientIP() falls back to the real peer address and the login
	// rate-limiter cannot be bypassed by header spoofing.
	_ = r.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"})

	r.GET("/health", func(c *gin.Context) {
		if healthCheck != nil {
			if err := healthCheck(c.Request.Context()); err != nil {
				c.JSON(503, gin.H{"status": "degraded"})
				return
			}
		}
		c.JSON(200, gin.H{"status": "ok", "db": "ok"})
	})

	api := r.Group("/api")
	{
		authGroup := api.Group("/auth")
		{
			authGroup.POST("/login", authService.Login)
			authGroup.POST("/refresh", authService.Refresh)
			authGroup.POST("/logout", authService.Logout)
		}

		// Public endpoints used by the anonymous download page.
		clientGroup := api.Group("/client")
		{
			clientGroup.GET("/info", func(c *gin.Context) {
				info := settingsStore.GetServerInfo(c.Request.Context(), cfg.HBBDBPath, c.Request.Host)
				code, err := settings.BuildConnectCode(info)
				if err != nil {
					c.JSON(400, gin.H{"error": err.Error()})
					return
				}
				c.JSON(200, gin.H{
					"host":       code.Host,
					"relay":      code.Relay,
					"key":        code.Key,
					"api":        code.API,
					"id_port":    info.IDPort.Value,
					"relay_port": info.RelayPort.Value,
					"ws_port":    info.WSPort.Value,
					"connect":    code,
				})
			})
			clientGroup.GET("/download", func(c *gin.Context) {
				c.JSON(200, settingsStore.GetDownloadPageConfig(c.Request.Context()))
			})
			clientGroup.Static("/screenshots", cfg.ScreenshotsDir)
		}

		protected := api.Group("/")
		protected.Use(authService.AuthMiddleware())
		{
			protected.PUT("/auth/password", authService.ChangeCredentials)

			devices := protected.Group("/devices")
			{
				devices.GET("", deviceService.ListDevices)
				devices.GET("/stream", deviceService.StreamDevices)
				devices.PATCH("/:id", deviceService.UpdateDevice)
				devices.DELETE("/:id", deviceService.DeleteDevice)
				devices.GET("/:id/password", deviceService.GetDevicePassword)
				devices.PUT("/:id/password", deviceService.SaveDevicePassword)
				devices.DELETE("/:id/password", deviceService.DeleteDevicePassword)
				devices.GET("/peer/:peerId/password", deviceService.GetPeerPassword)
				devices.PUT("/peer/:peerId/password", deviceService.SavePeerPassword)
				devices.PATCH("/peer/:peerId/peerinfo", deviceService.UpdatePeerInfo)
			}

			status := protected.Group("/status")
			{
				status.GET("", deviceService.GetServerStatus)
			}

			updates := protected.Group("/updates")
			{
				updates.GET("", updater.HandleCheck)
				updates.POST("/apply", updater.HandleApply)
			}

			panel := protected.Group("/panel")
			{
				panel.GET("/version", func(c *gin.Context) {
					c.JSON(200, gin.H{"version": appversion.Version})
				})
			}

			panelUpdates := protected.Group("/panel-updates")
			{
				panelUpdates.GET("/check", panelUpdater.HandleCheck)
				panelUpdates.GET("/status", panelUpdater.HandleStatus)
				panelUpdates.POST("/apply", panelUpdater.HandleApply)
				panelUpdates.GET("/log", panelUpdater.HandleLog)
				panelUpdates.POST("/reset", panelUpdater.HandleReset)
				panelUpdates.GET("/backups", panelUpdater.HandleBackups)
				panelUpdates.POST("/backups", panelUpdater.HandleCreateBackup)
				panelUpdates.DELETE("/backups/:name", panelUpdater.HandleDeleteBackup)
				panelUpdates.POST("/rollback", panelUpdater.HandleRollback)
				panelUpdates.GET("/preflight", panelUpdater.HandlePreflight)
			}

			settingGroup := protected.Group("/settings")
			{
				settingGroup.GET("", func(c *gin.Context) {
					c.JSON(200, gin.H{
						settings.RefreshIntervalKey:              settingsStore.GetRefreshInterval(c.Request.Context()),
						settings.StatusRefreshModeKey:            settingsStore.GetStatusRefreshMode(c.Request.Context()),
						settings.AccessTokenTTLKey:               settingsStore.AccessTokenTTLMinutes(c.Request.Context()),
						settings.RefreshTokenTTLKey:              settingsStore.RefreshTokenTTLDays(c.Request.Context()),
						settings.WebClientQualityKey:             settingsStore.WebClientQuality(c.Request.Context()),
						settings.WebClientFPSKey:                 settingsStore.WebClientFPS(c.Request.Context()),
						settings.WebClientCodecKey:               settingsStore.WebClientCodec(c.Request.Context()),
						settings.WebClientChatGreetingKey:        settingsStore.WebClientChatGreeting(c.Request.Context()),
						settings.WebClientChatGreetingEnabledKey: settingsStore.WebClientChatGreetingEnabled(c.Request.Context()),
						settings.WebClientChatCloseKey:           settingsStore.WebClientChatClose(c.Request.Context()),
						settings.WebClientChatCloseEnabledKey:    settingsStore.WebClientChatCloseEnabled(c.Request.Context()),
						settings.WebClientRenderScaleKey:         settingsStore.WebClientRenderScale(c.Request.Context()),
						settings.WebClientCursorKey:              settingsStore.WebClientCursor(c.Request.Context()),
						settings.WebClientInputModeKey:           settingsStore.WebClientInputMode(c.Request.Context()),
						settings.WebClientNameKey:                settingsStore.WebClientName(c.Request.Context()),
					})
				})
				settingGroup.PUT("/:key", func(c *gin.Context) {
					key := c.Param("key")
					if key == settings.RefreshIntervalKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}

						sec, err := strconv.Atoi(req.Value)
						if err != nil {
							c.JSON(400, gin.H{"error": "value must be an integer"})
							return
						}
						if sec < settings.MinRefreshInterval || sec > settings.MaxRefreshInterval {
							c.JSON(400, gin.H{"error": fmt.Sprintf("value must be between %d and %d seconds", settings.MinRefreshInterval, settings.MaxRefreshInterval)})
							return
						}

						if err := deviceService.SetRefreshInterval(c.Request.Context(), sec); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.RefreshIntervalKey: settingsStore.GetRefreshInterval(c.Request.Context()),
						})
						return
					}

					if key == settings.StatusRefreshModeKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidRefreshMode(req.Value) {
							c.JSON(400, gin.H{"error": "value must be either \"push\" or \"poll\""})
							return
						}
						if err := deviceService.SetStatusRefreshMode(c.Request.Context(), req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.StatusRefreshModeKey: settingsStore.GetStatusRefreshMode(c.Request.Context()),
						})
						return
					}

					if key == settings.AccessTokenTTLKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						min, err := strconv.Atoi(req.Value)
						if err != nil {
							c.JSON(400, gin.H{"error": "value must be an integer"})
							return
						}
						if min < settings.MinAccessTokenTTLMin || min > settings.MaxAccessTokenTTLMin {
							c.JSON(400, gin.H{"error": fmt.Sprintf("value must be between %d and %d minutes", settings.MinAccessTokenTTLMin, settings.MaxAccessTokenTTLMin)})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), settings.AccessTokenTTLKey, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.AccessTokenTTLKey: settingsStore.AccessTokenTTLMinutes(c.Request.Context()),
						})
						return
					}

					if key == settings.RefreshTokenTTLKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						days, err := strconv.Atoi(req.Value)
						if err != nil {
							c.JSON(400, gin.H{"error": "value must be an integer"})
							return
						}
						if days < settings.MinRefreshTokenTTLDays || days > settings.MaxRefreshTokenTTLDays {
							c.JSON(400, gin.H{"error": fmt.Sprintf("value must be between %d and %d days", settings.MinRefreshTokenTTLDays, settings.MaxRefreshTokenTTLDays)})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), settings.RefreshTokenTTLKey, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.RefreshTokenTTLKey: settingsStore.RefreshTokenTTLDays(c.Request.Context()),
						})
						return
					}

					if key == settings.WebClientQualityKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						q, err := strconv.Atoi(req.Value)
						if err != nil || (q != 0 && q != 2 && q != 3 && q != 4) {
							c.JSON(400, gin.H{"error": "value must be 0 (auto), 2, 3 or 4"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), settings.WebClientQualityKey, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.WebClientQualityKey: settingsStore.WebClientQuality(c.Request.Context()),
						})
						return
					}

					if key == settings.WebClientFPSKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						fps, err := strconv.Atoi(req.Value)
						if err != nil || fps < settings.MinWebClientFPS || fps > settings.MaxWebClientFPS {
							c.JSON(400, gin.H{"error": fmt.Sprintf("value must be between %d and %d", settings.MinWebClientFPS, settings.MaxWebClientFPS)})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), settings.WebClientFPSKey, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.WebClientFPSKey: settingsStore.WebClientFPS(c.Request.Context()),
						})
						return
					}

					if key == settings.WebClientCodecKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientCodec(req.Value) {
							c.JSON(400, gin.H{"error": "value must be auto, vp8, vp9 or av1"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), settings.WebClientCodecKey, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{
							settings.WebClientCodecKey: settingsStore.WebClientCodec(c.Request.Context()),
						})
						return
					}

					if key == settings.WebClientChatGreetingEnabledKey || key == settings.WebClientChatCloseEnabledKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientChatEnabled(req.Value) {
							c.JSON(400, gin.H{"error": "value must be true or false"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{key: req.Value == "true"})
						return
					}

					if key == settings.WebClientChatGreetingKey || key == settings.WebClientChatCloseKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientChatText(req.Value) {
							c.JSON(400, gin.H{"error": "value must be at most 2000 characters"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						if key == settings.WebClientChatGreetingKey {
							c.JSON(200, gin.H{key: settingsStore.WebClientChatGreeting(c.Request.Context())})
						} else {
							c.JSON(200, gin.H{key: settingsStore.WebClientChatClose(c.Request.Context())})
						}
						return
					}

					if key == settings.WebClientRenderScaleKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientRenderScale(req.Value) {
							c.JSON(400, gin.H{"error": "value must be auto, original, 144p, 240p, 360p, 480p, 720p, 1080p or 1440p"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{key: settingsStore.WebClientRenderScale(c.Request.Context())})
						return
					}

					if key == settings.WebClientCursorKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientChatEnabled(req.Value) {
							c.JSON(400, gin.H{"error": "value must be true or false"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{key: settingsStore.WebClientCursor(c.Request.Context())})
						return
					}

					if key == settings.WebClientInputModeKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientInputMode(req.Value) {
							c.JSON(400, gin.H{"error": "value must be auto, touch or pointer"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{key: settingsStore.WebClientInputMode(c.Request.Context())})
						return
					}

					if key == settings.WebClientNameKey {
						var req struct {
							Value string `json:"value"`
						}
						if err := c.ShouldBindJSON(&req); err != nil {
							c.JSON(400, gin.H{"error": "invalid request body"})
							return
						}
						if !settings.ValidWebClientName(req.Value) {
							c.JSON(400, gin.H{"error": "value must be 1-64 characters"})
							return
						}
						if err := settingsStore.Set(c.Request.Context(), key, req.Value); err != nil {
							c.JSON(500, gin.H{"error": "failed to save setting"})
							return
						}
						c.JSON(200, gin.H{key: settingsStore.WebClientName(c.Request.Context())})
						return
					}

					c.JSON(400, gin.H{"error": "unknown setting"})
				})
			}

			serverInfoGroup := protected.Group("/server-info")
			{
				serverInfoGroup.GET("", func(c *gin.Context) {
					c.JSON(200, settingsStore.GetServerInfo(
						c.Request.Context(),
						cfg.HBBDBPath,
						c.Request.Host,
					))
				})
				serverInfoGroup.GET("/connect-code", func(c *gin.Context) {
					info := settingsStore.GetServerInfo(c.Request.Context(), cfg.HBBDBPath, c.Request.Host)
					code, err := settings.BuildConnectCode(info)
					if err != nil {
						c.JSON(400, gin.H{"error": err.Error()})
						return
					}
					c.JSON(200, code)
				})
				serverInfoGroup.PUT("/:key", func(c *gin.Context) {
					key := c.Param("key")
					tableKey, ok := serverInfoSettingKeys[key]
					if !ok {
						c.JSON(400, gin.H{"error": "unknown server-info field"})
						return
					}

					var req struct {
						Value string `json:"value"`
					}
					if err := c.ShouldBindJSON(&req); err != nil {
						c.JSON(400, gin.H{"error": "invalid request body"})
						return
					}

					value := strings.TrimSpace(req.Value)
					if key == "address" || key == "relay_address" {
						if value != "" && !validHostname(value) {
							c.JSON(400, gin.H{"error": "address must be a hostname, IPv4 or bracketed IPv6 without scheme, path or port"})
							return
						}
					}
					if key == "api_server" {
						if value != "" && !validAPIServer(value) {
							c.JSON(400, gin.H{"error": "api server must be a valid http(s) URL without spaces or userinfo"})
							return
						}
					}
					switch key {
					case "id_port", "relay_port", "ws_port":
						if value != "" {
							p, err := strconv.Atoi(value)
							if err != nil || p < 1 || p > 65535 {
								c.JSON(400, gin.H{"error": "port must be an integer 1-65535 or empty to use the default"})
								return
							}
						}
					case "public_key":
						if value != "" && !validServerPublicKey(value) {
							c.JSON(400, gin.H{"error": "public key must be base64-encoded 32 bytes"})
							return
						}
					}

					if err := settingsStore.Set(c.Request.Context(), tableKey, value); err != nil {
						c.JSON(500, gin.H{"error": "failed to save server info"})
						return
					}
					info := settingsStore.GetServerInfo(c.Request.Context(), cfg.HBBDBPath, c.Request.Host)
					c.JSON(200, gin.H{key: serverInfoFieldJSON(info, key)})
				})
			}

			downloadConfig := protected.Group("/download-config")
			{
				downloadConfig.GET("", func(c *gin.Context) {
					c.JSON(200, settingsStore.GetDownloadPageConfig(c.Request.Context()))
				})
				downloadConfig.PUT("", func(c *gin.Context) {
					var cfg settings.DownloadPageConfig
					if err := c.ShouldBindJSON(&cfg); err != nil {
						c.JSON(400, gin.H{"error": "invalid request body"})
						return
					}
					if err := settingsStore.SaveDownloadPageConfig(c.Request.Context(), cfg); err != nil {
						c.JSON(400, gin.H{"error": err.Error()})
						return
					}
					c.JSON(200, settingsStore.GetDownloadPageConfig(c.Request.Context()))
				})
				downloadConfig.POST("/screenshots", func(c *gin.Context) {
					file, header, err := c.Request.FormFile("file")
					if err != nil {
						c.JSON(400, gin.H{"error": "missing file"})
						return
					}
					defer file.Close()
					data, err := io.ReadAll(io.LimitReader(file, settings.MaxScreenshotSize+1))
					if err != nil {
						c.JSON(400, gin.H{"error": "failed to read file"})
						return
					}
					if int64(len(data)) > settings.MaxScreenshotSize {
						c.JSON(400, gin.H{"error": "file too large (max 10 MiB)"})
						return
					}
					// Reject polyglot uploads: extension alone does not prove
					// the payload is an image served back to other visitors.
					if ct := http.DetectContentType(data); !strings.HasPrefix(ct, "image/") {
						c.JSON(400, gin.H{"error": "file is not an image"})
						return
					}
					name, err := settings.ScreenshotStorageName(filepath.Ext(header.Filename))
					if err != nil {
						c.JSON(400, gin.H{"error": err.Error()})
						return
					}
					dst, err := settings.ResolveScreenshotPath(cfg.ScreenshotsDir, name)
					if err != nil {
						c.JSON(400, gin.H{"error": err.Error()})
						return
					}
					if err := os.WriteFile(dst, data, 0o644); err != nil {
						c.JSON(500, gin.H{"error": "failed to save screenshot"})
						return
					}
					entry := settings.ScreenshotEntry{
						ID:  name,
						URL: "/api/client/screenshots/" + name,
					}
					// Record the new file in the page config; a save failure here
					// is not fatal — the file itself is already usable.
					cfg := settingsStore.GetDownloadPageConfig(c.Request.Context())
					cfg.Screenshots = append(cfg.Screenshots, entry)
					if err := settingsStore.SaveDownloadPageConfig(c.Request.Context(), cfg); err != nil {
						c.JSON(500, gin.H{"error": "failed to update page config: " + err.Error()})
						return
					}
					c.JSON(200, entry)
				})
				downloadConfig.DELETE("/screenshots/:file", func(c *gin.Context) {
					name := c.Param("file")
					p, err := settings.ResolveScreenshotPath(cfg.ScreenshotsDir, name)
					if err != nil {
						c.JSON(400, gin.H{"error": err.Error()})
						return
					}
					if err := os.Remove(p); err != nil {
						if os.IsNotExist(err) {
							c.JSON(404, gin.H{"error": "file not found"})
							return
						}
						c.JSON(500, gin.H{"error": "failed to delete screenshot"})
						return
					}
					cfg := settingsStore.GetDownloadPageConfig(c.Request.Context())
					filtered := cfg.Screenshots[:0]
					for _, s := range cfg.Screenshots {
						if s.URL != "/api/client/screenshots/"+name {
							filtered = append(filtered, s)
						}
					}
					cfg.Screenshots = filtered
					_ = settingsStore.SaveDownloadPageConfig(c.Request.Context(), cfg)
					c.JSON(200, gin.H{"ok": true})
				})
			}
		}
	}

	return r
}
