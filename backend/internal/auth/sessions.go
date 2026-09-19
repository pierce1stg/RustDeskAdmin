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
// errInvalidSession marks a refresh token whose session is missing or already
// rotated/expired.
var errInvalidSession = errors.New("invalid session")

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
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at)`)
	return err
}

// pruneExpired removes sessions whose expiry has passed. Called before issuing
// new tokens so the table cannot grow without bound.
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
	jti, err := newJTI()
	if err != nil {
		return "", time.Time{}, err
	}
	expiry := time.Now().Add(ttl)
	_, err = s.pool.Exec(ctx,
		`INSERT INTO auth_sessions (jti, user_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
		jti, userID, email, expiry,
	)
	if err != nil {
		return "", time.Time{}, err
	}
	return jti, expiry, nil
}

// consume atomically validates and rotates a session: the row is deleted only
// if it exists and has not expired, so two concurrent refreshes with the same
// token cannot both succeed. errInvalidSession marks a missing/expired/foreign
// token (already rotated).
func (s *sessionStore) consume(ctx context.Context, jti string) error {
	if jti == "" {
		return errInvalidSession
	}
	if err := s.ensureTable(ctx); err != nil {
		return err
	}
	// Best-effort: keep the table small on every rotation too.
	_, _ = s.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE expires_at <= NOW()`)
	var deleted string
	err := s.pool.QueryRow(ctx,
		`DELETE FROM auth_sessions WHERE jti = $1 AND expires_at > NOW() RETURNING jti`, jti,
	).Scan(&deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return errInvalidSession
	}
	return err
}

// revoke drops a single session (logout). Missing rows are not an error:
// logout is idempotent.
func (s *sessionStore) revoke(ctx context.Context, jti string) error {
	if jti == "" {
		return nil
	}
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
func newJTI() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
