package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// sessionStore tracks every refresh token currently issued. Sessions live in
// the database (auth_sessions table) so a backend restart does not log anyone
// out. Tokens are rotated on each refresh (the presented token becomes
// single-use) and every session is revoked when the credentials change, so a
// stolen refresh token stops working as soon as it is reused or credentials
// are rotated.
type sessionStore struct {
	pool *pgxpool.Pool
}

func newSessionStore(pool *pgxpool.Pool) *sessionStore {
	return &sessionStore{pool: pool}
}

// ensureTable creates the auth_sessions table if it is missing. It is called
// lazily on the first session operation so existing deployments do not need a
// migration runner; the table appears in the same database as the settings.
func (s *sessionStore) ensureTable(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS auth_sessions (
			jti        TEXT PRIMARY KEY,
			user_id    TEXT NOT NULL,
			email      TEXT NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	return err
}

// pruneExpiredLocked removes sessions whose expiry has passed. Called before
// issuing new tokens so the table cannot grow without bound.
func (s *sessionStore) pruneExpired(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE expires_at <= NOW()`)
	return err
}

// issue registers a new session and returns its jti and expiry.
func (s *sessionStore) issue(ctx context.Context, userID, email string, ttl time.Duration) (string, time.Time, error) {
	if err := s.ensureTable(ctx); err != nil {
		return "", time.Time{}, err
	}
	if err := s.pruneExpired(ctx); err != nil {
		return "", time.Time{}, err
	}
	jti := newJTI()
	expiry := time.Now().Add(ttl)
	_, err := s.pool.Exec(ctx,
		`INSERT INTO auth_sessions (jti, user_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
		jti, userID, email, expiry,
	)
	if err != nil {
		return "", time.Time{}, err
	}
	return jti, expiry, nil
}

// isValid reports whether jti belongs to a live session, deleting the row once
// it has expired.
func (s *sessionStore) isValid(ctx context.Context, jti string) (bool, error) {
	if jti == "" {
		return false, nil
	}
	if err := s.ensureTable(ctx); err != nil {
		return false, err
	}
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT expires_at FROM auth_sessions WHERE jti = $1`, jti,
	).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !expiresAt.After(time.Now()) {
		_, _ = s.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE jti = $1`, jti)
		return false, nil
	}
	return true, nil
}

// revoke drops a single session (refresh token rotation).
func (s *sessionStore) revoke(ctx context.Context, jti string) error {
	if err := s.ensureTable(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE jti = $1`, jti)
	return err
}

// revokeAll drops every session (credential change).
func (s *sessionStore) revokeAll(ctx context.Context) error {
	if err := s.ensureTable(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_sessions`)
	return err
}

// newJTI returns a random token identifier used to correlate refresh tokens
// with their server-side session entries.
func newJTI() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
