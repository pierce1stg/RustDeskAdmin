package device

import (
	"strings"
	"testing"
)

func TestValidatePeerInfoDisplay(t *testing.T) {
	ok := PeerInfoDisplay{Name: "DP-1", X: 0, Y: 0, Width: 1920, Height: 1080}
	if err := validatePeerInfoDisplay(ok); err != nil {
		t.Fatalf("valid display rejected: %v", err)
	}
	bad := []PeerInfoDisplay{
		{Name: strings.Repeat("x", 129)},
		{Width: 0, Height: 1080},
		{Width: 1920, Height: 0},
		{Width: 20000, Height: 1080},
		{Width: 1920, Height: -1},
	}
	for i, d := range bad {
		if err := validatePeerInfoDisplay(d); err == nil {
			t.Fatalf("case %d accepted, want error", i)
		}
	}
}
