package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"rustdesk-admin/internal/settings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrTokenExpired = errors.New("token expired")
)

type Service struct {
	jwtSecret        []byte
	jwtRefreshSecret []byte
	settings         *settings.Store
	loginLimits      *loginLimiter
	sessions         *sessionStore
}

// dummyPasswordHash is a real bcrypt hash of an unused password. Comparing a
// login attempt against it makes the response time independent of whether the
// username exists, so attackers cannot enumerate valid usernames.
var dummyPasswordHash = func() string {
	h, err := bcrypt.GenerateFromPassword([]byte("dummy-password"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	return string(h)
}()

type Claims struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type ChangeCredentialsRequest struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewUsername     string `json:"new_username"`
	NewPassword     string `json:"new_password"`
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func NewService(jwtSecret, jwtRefreshSecret string, pool *pgxpool.Pool, settingsStore *settings.Store) *Service {
	return &Service{
		jwtSecret:        []byte(jwtSecret),
		jwtRefreshSecret: []byte(jwtRefreshSecret),
		settings:         settingsStore,
		loginLimits:      newLoginLimiter(15*time.Minute, 10),
		sessions:         newSessionStore(pool),
	}
}

// accessTokenTTL returns the access-token lifetime from the settings table
// (clamped by settings.Store), used for every token issued afterwards.
func (s *Service) accessTokenTTL(ctx context.Context) time.Duration {
	return time.Duration(s.settings.AccessTokenTTLMinutes(ctx)) * time.Minute
}

// refreshTokenTTL returns the refresh-token lifetime from the settings table.
func (s *Service) refreshTokenTTL(ctx context.Context) time.Duration {
	return time.Duration(s.settings.RefreshTokenTTLDays(ctx)) * 24 * time.Hour
}

// credentials returns the stored admin username and password hash.
func (s *Service) credentials(ctx context.Context) (username, hash string) {
	username, _ = s.settings.Get(ctx, settings.AdminUsernameKey, settings.DefaultAdminUsername)
	hash, _ = s.settings.Get(ctx, settings.AdminPasswordHashKey, "")
	return
}

func (s *Service) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Rate-limit per IP + username before doing any password work.
	limitKey := c.ClientIP() + "|" + strings.ToLower(req.Username)
	if !s.loginLimits.allow(limitKey) {
		c.JSON(429, gin.H{"error": "too many login attempts, try again later"})
		return
	}

	username, hash := s.credentials(c.Request.Context())
	if hash == "" || req.Username != username {
		// Unknown username (or not yet seeded): burn the same time as a real
		// bcrypt compare so the response does not leak whether the user exists.
		_ = bcrypt.CompareHashAndPassword([]byte(dummyPasswordHash), []byte(req.Password))
		c.JSON(401, gin.H{"error": "invalid credentials"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		c.JSON(401, gin.H{"error": "invalid credentials"})
		return
	}

	s.loginLimits.reset(limitKey)

	userID, email := "1", req.Username
	accessToken, err := s.generateAccessToken(userID, email, s.accessTokenTTL(c.Request.Context()))
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to generate token"})
		return
	}

	jti, refreshExpiry, err := s.sessions.issue(c.Request.Context(), userID, email, s.refreshTokenTTL(c.Request.Context()))
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to create session"})
		return
	}
	refreshToken, err := s.generateRefreshToken(userID, email, jti, refreshExpiry)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to generate refresh token"})
		return
	}

	c.JSON(200, TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	})
}

func (s *Service) ChangeCredentials(c *gin.Context) {
	var req ChangeCredentialsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	username, hash := s.credentials(ctx)
	if hash == "" || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.CurrentPassword)) != nil {
		c.JSON(401, gin.H{"error": "current password is incorrect"})
		return
	}

	newUsername := strings.TrimSpace(req.NewUsername)
	newPassword := req.NewPassword

	if newUsername == "" && newPassword == "" {
		c.JSON(400, gin.H{"error": "provide a new username or a new password"})
		return
	}
	if len(newUsername) > 32 {
		c.JSON(400, gin.H{"error": "username is too long (max 32 characters)"})
		return
	}
	if newPassword != "" && len(newPassword) < 8 {
		c.JSON(400, gin.H{"error": "new password must be at least 8 characters"})
		return
	}

	if newPassword != "" {
		hashed, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
		if err != nil {
			c.JSON(500, gin.H{"error": "failed to hash password"})
			return
		}
		if err := s.settings.Set(ctx, settings.AdminPasswordHashKey, string(hashed)); err != nil {
			c.JSON(500, gin.H{"error": "failed to save new password"})
			return
		}
	}
	if newUsername != "" && newUsername != username {
		if err := s.settings.Set(ctx, settings.AdminUsernameKey, newUsername); err != nil {
			c.JSON(500, gin.H{"error": "failed to save new username"})
			return
		}
	}

	// Credentials changed: every existing session must sign in again.
	if err := s.sessions.revokeAll(ctx); err != nil {
		c.JSON(500, gin.H{"error": "failed to revoke sessions"})
		return
	}

	c.JSON(200, gin.H{"message": "credentials updated"})
}

func (s *Service) Refresh(c *gin.Context) {
	var req struct {
		RefreshToken string `json:"refresh_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	claims, err := s.parseToken(req.RefreshToken, s.jwtRefreshSecret)
	if err != nil {
		c.JSON(401, gin.H{"error": "invalid refresh token"})
		return
	}

	// A valid-but-unknown jti means the presented token was already rotated or
	// the server has no record of it. Reject that single token: the admin is
	// signed out once, without nuking every other active session.
	ok, err := s.sessions.isValid(c.Request.Context(), claims.ID)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to check session"})
		return
	}
	if !ok {
		c.JSON(401, gin.H{"error": "invalid refresh token"})
		return
	}

	// Rotate: the presented refresh token is now single-use.
	if err := s.sessions.revoke(c.Request.Context(), claims.ID); err != nil {
		c.JSON(500, gin.H{"error": "failed to rotate token"})
		return
	}

	userID, email := claims.UserID, claims.Email
	accessToken, err := s.generateAccessToken(userID, email, s.accessTokenTTL(c.Request.Context()))
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to generate token"})
		return
	}

	jti, refreshExpiry, err := s.sessions.issue(c.Request.Context(), userID, email, s.refreshTokenTTL(c.Request.Context()))
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to create session"})
		return
	}
	refreshToken, err := s.generateRefreshToken(userID, email, jti, refreshExpiry)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to generate refresh token"})
		return
	}

	c.JSON(200, TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	})
}

func (s *Service) AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.AbortWithStatusJSON(401, gin.H{"error": "authorization header required"})
			return
		}

		tokenString := authHeader
		if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
			tokenString = authHeader[7:]
		}

		claims, err := s.parseToken(tokenString, s.jwtSecret)
		if err != nil {
			c.AbortWithStatusJSON(401, gin.H{"error": "invalid token"})
			return
		}

		c.Set("user_id", claims.UserID)
		c.Set("email", claims.Email)
		c.Next()
	}
}

func (s *Service) generateAccessToken(userID, email string, ttl time.Duration) (string, error) {
	claims := Claims{
		UserID: userID,
		Email:  email,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Subject:   userID,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func (s *Service) generateRefreshToken(userID, email, jti string, expiresAt time.Time) (string, error) {
	claims := Claims{
		UserID: userID,
		Email:  email,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        jti,
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Subject:   userID,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtRefreshSecret)
}

func (s *Service) parseToken(tokenString string, secret []byte) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return secret, nil
	})

	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		return nil, ErrInvalidToken
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}
	return nil, ErrInvalidToken
}
