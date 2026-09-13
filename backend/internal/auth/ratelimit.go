package auth

import (
	"sync"
	"time"
)

// loginLimiter is a small in-memory rate limiter for the login endpoint. Each
// key (client IP + username) is allowed a fixed number of attempts per window;
// a successful login clears the attempts for that key. Expired buckets are
// pruned lazily so the map stays small for a single-admin deployment.
type loginLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	max      int
	attempts map[string]loginAttempt
}

type loginAttempt struct {
	count int
	start time.Time
}

func newLoginLimiter(window time.Duration, max int) *loginLimiter {
	return &loginLimiter{
		window:   window,
		max:      max,
		attempts: make(map[string]loginAttempt),
	}
}

// allow records an attempt against key and reports whether it is permitted.
func (l *loginLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	prev, ok := l.attempts[key]
	if !ok || now.Sub(prev.start) >= l.window {
		prev = loginAttempt{start: now}
	}
	prev.count++
	l.attempts[key] = prev

	if prev.count > l.max {
		return false
	}

	// Keep the map bounded as IPs rotate: drop expired buckets once the map
	// grows past a slack threshold.
	if len(l.attempts) > 2048 {
		for k, a := range l.attempts {
			if now.Sub(a.start) >= l.window {
				delete(l.attempts, k)
			}
		}
	}
	return true
}

// reset forgets every failed attempt for key (called after a successful login).
func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}
