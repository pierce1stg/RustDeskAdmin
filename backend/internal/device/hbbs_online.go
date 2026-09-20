package device

import (
	"context"
	"fmt"
	"net"
	"time"
)

// Authoritative online verdict straight from hbbs, the same way the native
// RustDesk client asks it (rendezvous_server handle_online_request): hbbs
// keeps a per-peer last-heartbeat timestamp in memory and reports a peer
// online iff it heard from it within REG_TIMEOUT (30s). Keyed by peer ID,
// so shared NATs can never confuse peers — unlike our socket-IP guessing,
// which stays only as a fallback for when hbbs is unreachable.
//
// Wire format (libs/hbb_common BytesCodec + rendezvous.proto):
// frame = varlen-header(len<<2 | (headlen-1)) + protobuf.
// RendezvousMessage{ online_request = 23 }: tag 0xBA 0x01.
// OnlineRequest{ peers = 2 repeated string }: per peer 0x12 len bytes.
// Answer OnlineResponse{ states = 1 }: tag 0xC2 0x01, bit (7-i%8) of byte
// i/8 is the online flag of peers[i].

const (
	hbbsOnlineFieldRequest  = 23
	hbbsOnlineFieldResponse = 24
	hbbsOnlineDialTimeout   = 3 * time.Second
	hbbsOnlineReadTimeout   = 5 * time.Second
	hbbsOnlineChunkSize     = 50
)

// encodeHbbsFrame prefixes a protobuf payload with the BytesCodec length
// header (general 1-4 byte form; requests here are small).
func encodeHbbsFrame(payload []byte) []byte {
	v := uint32(len(payload) << 2)
	h := 1
	for v >= uint32(1)<<(8*h-2) && h < 4 {
		h++
	}
	v |= uint32(h - 1)
	out := make([]byte, 0, h+len(payload))
	for i := 0; i < h; i++ {
		out = append(out, byte(v>>(8*i)))
	}
	return append(out, payload...)
}

// decodeHbbsFrame reads one BytesCodec frame from conn.
func decodeHbbsFrame(conn net.Conn) ([]byte, error) {
	head := make([]byte, 1)
	if _, err := readFull(conn, head); err != nil {
		return nil, err
	}
	h := int(head[0]&3) + 1
	rest := make([]byte, h-1)
	if _, err := readFull(conn, rest); err != nil {
		return nil, err
	}
	full := append(head, rest...)
	var v uint32
	for i := 0; i < h; i++ {
		v |= uint32(full[i]) << (8 * i)
	}
	n := int(v >> 2)
	if n > 1<<20 {
		return nil, fmt.Errorf("hbbs frame too large: %d", n)
	}
	payload := make([]byte, n)
	if _, err := readFull(conn, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	got := 0
	for got < len(buf) {
		n, err := conn.Read(buf[got:])
		got += n
		if err != nil {
			return got, err
		}
	}
	return got, nil
}

func encodeVarint(out []byte, v uint64) []byte {
	for v >= 0x80 {
		out = append(out, byte(v)|0x80)
		v >>= 7
	}
	return append(out, byte(v))
}

// encodeOnlineRequest builds RendezvousMessage{online_request: {peers}}.
func encodeOnlineRequest(peers []string) []byte {
	inner := make([]byte, 0, len(peers)*12)
	for _, p := range peers {
		inner = append(inner, 0x12)
		inner = encodeVarint(inner, uint64(len(p)))
		inner = append(inner, p...)
	}
	msg := encodeVarint(nil, uint64(hbbsOnlineFieldRequest<<3|2))
	msg = encodeVarint(msg, uint64(len(inner)))
	msg = append(msg, inner...)
	return msg
}

// parseOnlineResponse extracts the online bitmask for exactly len(peers).
func parseOnlineResponse(frame []byte, nPeers int) ([]bool, error) {
	out := make([]bool, nPeers)
	if len(frame) < 2 || frame[0] != 0xC2 || frame[1] != 0x01 {
		return nil, fmt.Errorf("not an online_response frame")
	}
	rest := frame[2:]
	ln, m := decodeVarint(rest)
	if m <= 0 || len(rest) < m+int(ln) {
		return nil, fmt.Errorf("bad online_response length")
	}
	body := rest[m : m+int(ln)]
	if len(body) < 2 || body[0] != 0x0A {
		return nil, fmt.Errorf("no states field")
	}
	sl, k := decodeVarint(body[1:])
	if k <= 0 || len(body) < 1+k+int(sl) {
		return nil, fmt.Errorf("bad states length")
	}
	states := body[1+k : 1+k+int(sl)]
	for i := 0; i < nPeers; i++ {
		if i/8 < len(states) && states[i/8]&(1<<(7-i%8)) != 0 {
			out[i] = true
		}
	}
	return out, nil
}

func decodeVarint(buf []byte) (uint64, int) {
	var v uint64
	var shift uint
	for i, b := range buf {
		if i >= 10 {
			return 0, -1
		}
		v |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return v, i + 1
		}
		shift += 7
	}
	return 0, -1
}

// queryHbbsOnline asks hbbs for the authoritative online flags of decIDs
// (decimal peer id strings). One TCP connection is reused for chunked
// requests. Any failure returns an error and no partial map — the caller
// falls back to socket-based detection.
func queryHbbsOnline(ctx context.Context, addr string, decIDs []string) (map[string]bool, error) {
	if len(decIDs) == 0 {
		return map[string]bool{}, nil
	}
	dialer := &net.Dialer{Timeout: hbbsOnlineDialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(hbbsOnlineReadTimeout))

	out := make(map[string]bool, len(decIDs))
	for start := 0; start < len(decIDs); start += hbbsOnlineChunkSize {
		end := start + hbbsOnlineChunkSize
		if end > len(decIDs) {
			end = len(decIDs)
		}
		chunk := decIDs[start:end]
		frame := encodeHbbsFrame(encodeOnlineRequest(chunk))
		if _, err := conn.Write(frame); err != nil {
			return nil, err
		}
		resp, err := decodeHbbsFrame(conn)
		if err != nil {
			return nil, err
		}
		flags, err := parseOnlineResponse(resp, len(chunk))
		if err != nil {
			return nil, err
		}
		for i, id := range chunk {
			out[id] = flags[i]
		}
	}
	return out, nil
}
