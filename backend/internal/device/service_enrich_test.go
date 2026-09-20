package device

import (
	"testing"
	"time"
)

func TestEnrichConnsSnapshotStale(t *testing.T) {
	s := &Service{}
	// Hex peer ids as stored in DB (decode to 176902107 / 5377615).
	sonya, pk := "313736393032313037", "35333737363135"
	aliases := map[string]string{sonya: "Sonya"}
	primary := map[string]string{}
	info := map[string]string{sonya: "10.0.0.9", pk: "10.0.0.9"}
	online := map[string]bool{sonya: true, pk: false}

	// Live socket, peer online -> clean row, counted.
	live := []presenceConn{{IP: "10.0.0.9", Port: 21116, LastRcvMs: int64ptr(5000)}}
	out, n := s.enrichConnsSnapshot(live, aliases, primary, map[string]string{sonya: "10.0.0.9"}, online, map[string]time.Time{})
	if n != 1 || len(out) != 1 || out[0].Stale {
		t.Fatalf("live+online: got %+v count %d, want clean row", out, n)
	}
	if out[0].PeerID != "176902107" || out[0].Alias != "Sonya" {
		t.Fatalf("labels = %q/%q, want 176902107/Sonya", out[0].PeerID, out[0].Alias)
	}

	// Silent ghost socket -> stale row, not counted.
	ghost := []presenceConn{{IP: "10.0.0.9", Port: 21116, LastRcvMs: int64ptr(7_200_000)}}
	out, n = s.enrichConnsSnapshot(ghost, aliases, primary, info, online, map[string]time.Time{})
	if n != 0 || len(out) != 1 || !out[0].Stale {
		t.Fatalf("ghost: got %+v count %d, want stale row, count 0", out, n)
	}

	// Live socket but attributed peer offline -> stale row, still counted
	// (the socket itself is real; only the peer label is dimmed).
	out, n = s.enrichConnsSnapshot(live, aliases, primary, map[string]string{pk: "10.0.0.9"}, online, map[string]time.Time{})
	if n != 1 || len(out) != 1 || !out[0].Stale {
		t.Fatalf("live+offline peer: got %+v count %d, want stale row, count 1", out, n)
	}
	if out[0].PeerID != "5377615" {
		t.Fatalf("peer label = %q, want 5377615", out[0].PeerID)
	}

	// Unknown liveness (old sampler) fails open: clean row, counted.
	na := []presenceConn{{IP: "10.0.0.9", Port: 21116}}
	out, n = s.enrichConnsSnapshot(na, aliases, primary, info, online, map[string]time.Time{})
	if n != 1 || len(out) != 1 || out[0].Stale {
		t.Fatalf("unknown liveness: got %+v count %d, want clean row", out, n)
	}
}

func TestEnrichConnsSnapshotDistinctPeers(t *testing.T) {
	s := &Service{}
	sonya, pk := "313736393032313037", "35333737363135"
	aliases := map[string]string{sonya: "Sonya", pk: "PK"}
	info := map[string]string{sonya: "10.0.0.9", pk: "10.0.0.9"}
	online := map[string]bool{sonya: true, pk: true}
	// Two sockets, two peers behind one IP: rows must name distinct peers,
	// most-recently-active first, and never flap between identical calls.
	conns := []presenceConn{
		{IP: "10.0.0.9", Port: 21116, LastRcvMs: int64ptr(1000)},
		{IP: "10.0.0.9", Port: 21117, LastRcvMs: int64ptr(2000)},
	}
	seen := map[string]time.Time{
		sonya: time.Unix(100, 0),
		pk:    time.Unix(200, 0),
	}
	for i := 0; i < 3; i++ {
		out, n := s.enrichConnsSnapshot(conns, aliases, map[string]string{}, info, online, seen)
		if n != 2 || len(out) != 2 {
			t.Fatalf("iter %d: got %+v count %d, want 2 rows count 2", i, out, n)
		}
		if out[0].PeerID != "5377615" || out[1].PeerID != "176902107" {
			t.Fatalf("iter %d: rows = %q/%q, want 5377615/176902107 (MRU first, stable)", i, out[0].PeerID, out[1].PeerID)
		}
		if out[0].Stale || out[1].Stale {
			t.Fatalf("iter %d: live rows must not be stale: %+v", i, out)
		}
	}
}
