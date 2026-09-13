// Package appversion is the single source of truth for the panel version.
// It is bumped by scripts/release.sh on every release; the value must match
// the git tag (without the leading "v").
package appversion

const Version = "0.1.0"
