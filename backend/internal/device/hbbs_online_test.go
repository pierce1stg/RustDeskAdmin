package device

import (
	"bytes"
	"testing"
)

func TestHbbsFrameRoundtrip(t *testing.T) {
	for _, n := range []int{0, 1, 44, 63, 64, 300, 70000} {
		payload := bytes.Repeat([]byte{0xAB}, n)
		frame := encodeHbbsFrame(payload)
		// decode header manually
		h := int(frame[0]&3) + 1
		var v uint32
		for i := 0; i < h; i++ {
			v |= uint32(frame[i]) << (8 * i)
		}
		if int(v>>2) != n {
			t.Fatalf("n=%d: header decodes %d", n, v>>2)
		}
		if !bytes.Equal(frame[h:], payload) {
			t.Fatalf("n=%d: payload corrupted", n)
		}
	}
}

func TestEncodeOnlineRequest(t *testing.T) {
	msg := encodeOnlineRequest([]string{"176902107", "5377615"})
	// RendezvousMessage.online_request = 23 -> tag BA 01, then len, then
	// OnlineRequest.peers = 2 -> 12 len bytes per peer.
	if len(msg) < 4 || msg[0] != 0xBA || msg[1] != 0x01 {
		t.Fatalf("bad outer tag: %x", msg)
	}
	inner := msg[3:]
	if !bytes.Contains(inner, []byte("\x12\x09176902107")) {
		t.Fatalf("peer missing: %x", msg)
	}
	if !bytes.Contains(inner, []byte("\x12\x075377615")) {
		t.Fatalf("peer missing: %x", msg)
	}
}

func TestParseOnlineResponse(t *testing.T) {
	// Captured live from hbbs: peers [176902107 5377615 308415599 1855106718]
	// answered [offline ONLINE ONLINE offline].
	frame := []byte{0xC2, 0x01, 0x03, 0x0A, 0x01, 0x60}
	got, err := parseOnlineResponse(frame, 4)
	if err != nil {
		t.Fatal(err)
	}
	want := []bool{false, true, true, false}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("peer %d: got %v want %v", i, got[i], want[i])
		}
	}
	if _, err := parseOnlineResponse([]byte{0x00}, 1); err == nil {
		t.Fatal("garbage must fail")
	}
	if _, err := parseOnlineResponse([]byte{0xC2, 0x01, 0x05, 0x0A}, 1); err == nil {
		t.Fatal("truncated must fail")
	}
}
