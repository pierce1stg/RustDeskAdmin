package device

import (
	"strings"
	"testing"
	"time"
)

func int64ptr(v int64) *int64 { return &v }

func TestConnIsActive(t *testing.T) {
	if !connIsActive(nil) {
		t.Error("nil liveness must fail open (old sampler)")
	}
	for _, ms := range []int64{0, 5648, 14406, connActiveAfterMs} {
		if !connIsActive(int64ptr(ms)) {
			t.Errorf("lastrcv %d must count as active", ms)
		}
	}
	for _, ms := range []int64{connActiveAfterMs + 1, 3_600_000, 86_400_000} {
		if connIsActive(int64ptr(ms)) {
			t.Errorf("lastrcv %d must count as ghost", ms)
		}
	}
}

func testPresenceService() *Service {
	return &Service{
		peerPrimary:   make(map[string]string),
		peerPrimaryTs: make(map[string]int64),
		peerInfoIP:    make(map[string]string),
		lastOnline:    make(map[string]time.Time),
		onlineState:   make(map[string]bool),
		onlineSource:  make(map[string]string),
	}
}

func TestComputeOnlineIgnoresGhostSockets(t *testing.T) {
	s := testPresenceService()
	s.peerInfoIP["AA"] = "10.0.0.5"
	known := map[string]bool{"AA": true}
	// Silent leftover of a powered-off PC: ESTABLISHED for hours, no data.
	snap := &presenceSnapshot{
		HbbsConns: []presenceConn{{IP: "10.0.0.5", Port: 21116, LastRcvMs: int64ptr(7_200_000)}},
	}
	res := s.computeOnline(snap, known)
	if res["AA"] {
		t.Error("ghost socket must not mark peer online")
	}
	if _, ok := s.onlineSource["AA"]; ok {
		t.Error("ghost socket must not set a source")
	}
}

func TestComputeOnlineLiveSocket(t *testing.T) {
	s := testPresenceService()
	s.peerInfoIP["AA"] = "10.0.0.5"
	known := map[string]bool{"AA": true}
	snap := &presenceSnapshot{
		HbbsConns: []presenceConn{{IP: "10.0.0.5", Port: 21116, LastRcvMs: int64ptr(5648)}},
	}
	res := s.computeOnline(snap, known)
	if !res["AA"] {
		t.Error("live socket must mark peer online")
	}
	if got := s.onlineSource["AA"]; got != "conn:10.0.0.5" {
		t.Errorf("source = %q, want conn:10.0.0.5", got)
	}
}

func TestComputeOnlineSharedIPFlagged(t *testing.T) {
	s := testPresenceService()
	for _, p := range []string{"AA", "BB", "CC"} {
		s.peerInfoIP[p] = "10.0.0.9"
	}
	known := map[string]bool{"AA": true, "BB": true, "CC": true}
	snap := &presenceSnapshot{
		HbbsConns: []presenceConn{{IP: "10.0.0.9", Port: 21116, LastRcvMs: int64ptr(3000)}},
	}
	res := s.computeOnline(snap, known)
	on := 0
	for p, v := range res {
		if v {
			on++
			if got := s.onlineSource[p]; !strings.HasPrefix(got, "shared:10.0.0.9") {
				t.Errorf("ambiguous pick source = %q, want shared: prefix", got)
			}
		}
	}
	if on != 1 {
		t.Errorf("one live socket must pick exactly one peer, got %d", on)
	}
}
