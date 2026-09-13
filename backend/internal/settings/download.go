package settings

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// DownloadPageConfigKey is the settings-table row that holds the public
// download page content. It is only written when the admin saves overrides;
// until then the frontend renders its built-in (i18n) defaults.
const DownloadPageConfigKey = "download_page_config"

// Supported interface languages on the download page. The content of the page
// (instructions, step screenshots, platform download buttons) is maintained
// independently for every language.
var SupportedDownloadLangs = []string{"en", "ru", "zh", "ar"}

// KnownDownloadPlatforms are the accepted platform keys.
var KnownDownloadPlatforms = []string{"windows", "macos", "linux", "android", "ios"}

// DefaultRustDeskVersion is pinned to the release whose assets the default
// download buttons point at. Bump it when seeding new defaults; existing admin
// edits are never overwritten.
const DefaultRustDeskVersion = "1.4.9"

// MaxScreenshotSize is the per-file upload limit.
var MaxScreenshotSize = int64(10 << 20) // 10 MiB

// AllowedScreenshotExts mirrors the file extensions the upload endpoint keeps.
var AllowedScreenshotExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true,
}

// LangStrings holds per-language free text. An empty value means "use the
// built-in (frontend i18n) default".
type LangStrings struct {
	En string `json:"en"`
	Ru string `json:"ru"`
	Zh string `json:"zh"`
	Ar string `json:"ar"`
}

// DownloadButton is one named download link on a platform card. Enabled=false
// hides it from the public page while keeping it in the admin config.
type DownloadButton struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
}

// KnownInstructionButtonColors are the preset colors the admin can pick for a
// device-block instruction button on the public page. An empty value renders
// the default primary button.
var KnownInstructionButtonColors = []string{"blue", "green", "red", "amber", "purple", "teal", "pink"}

// PlatformPageConfig is the per-platform section of the public download page.
// Order controls the sequence of device blocks on the public page; it equals
// the index in KnownDownloadPlatforms unless the admin reorders the blocks.
// Buttons holds an independent download-button list per language. The
// Instructions field is translated free text below those buttons.
type PlatformPageConfig struct {
	Enabled      bool                        `json:"enabled"`
	Instructions LangStrings                 `json:"instructions"`
	Order        int                         `json:"order"`
	Buttons      map[string][]DownloadButton `json:"buttons"`
}

// ScreenshotEntry is one image in the shared media library. Steps of the
// language-specific instruction lists reference these by URL.
type ScreenshotEntry struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// StepButton is one action button rendered below an instruction step. As an
// instruction belongs to a single language, the label is a plain string.
type StepButton struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

// InstructionStep is one numbered step of an instruction: free text, up to
// three screenshots per theme (ImagesLight for the light theme, ImagesDark for
// the dark theme; the public page renders the carousel matching the active
// theme) and a list of action buttons.
type InstructionStep struct {
	Text        string       `json:"text"`
	ImagesLight []string     `json:"imagesLight"`
	ImagesDark  []string     `json:"imagesDark"`
	Buttons     []StepButton `json:"buttons"`
}

// Instruction is a user-facing setup guide stored for exactly one language: a
// title and an ordered (but admin-reorderable) list of steps. Target
// optionally links the instruction to a platform so a colored entry button
// appears in that device block on the public page; an empty target keeps it
// general. Color is a preset from KnownInstructionButtonColors used for that
// entry button.
type Instruction struct {
	ID     string            `json:"id"`
	Target string            `json:"target"`
	Color  string            `json:"color"`
	Title  string            `json:"title"`
	Steps  []InstructionStep `json:"steps"`
}

// DownloadPageConfig is the admin-editable content of the public /download
// page. Platforms are keyed by the KnownDownloadPlatforms names and hold a
// per-language button list; Instructions are keyed by language. Localized
// controls whether the public page offers a visitor language switch (true) or
// renders a single language (false): in the monolingual mode Lang is the
// language the page is pinned to.
type DownloadPageConfig struct {
	Title                 LangStrings                   `json:"title"`
	Subtitle              LangStrings                   `json:"subtitle"`
	Intro                 LangStrings                   `json:"intro"`
	InstructionsTitle     LangStrings                   `json:"instructionsTitle"`
	Platforms             map[string]PlatformPageConfig `json:"platforms"`
	Screenshots           []ScreenshotEntry             `json:"screenshots"`
	Instructions          map[string][]Instruction      `json:"instructions"`
	Localized             bool                          `json:"localized"`
	Lang                  string                        `json:"lang"`
	ShowConnectionDetails bool                          `json:"showConnectionDetails"`
}

// DefaultDownloadPageConfig returns the built-in layout: every platform on
// with empty text (frontend falls back to its i18n defaults) and a set of
// per-architecture download buttons seeded from the latest official RustDesk
// release in every language. Admins can rename, link, hide or delete them
// freely per language.
func DefaultDownloadPageConfig() DownloadPageConfig {
	platforms := map[string]PlatformPageConfig{}
	for i, k := range KnownDownloadPlatforms {
		buttons := map[string][]DownloadButton{}
		for _, lang := range SupportedDownloadLangs {
			buttons[lang] = defaultDownloadButtons(k)
		}
		platforms[k] = PlatformPageConfig{
			Enabled: true,
			Buttons: buttons,
			Order:   i,
		}
	}
	instructions := map[string][]Instruction{}
	for _, lang := range SupportedDownloadLangs {
		instructions[lang] = []Instruction{}
	}
	return DownloadPageConfig{
		Platforms:    platforms,
		Screenshots:  []ScreenshotEntry{},
		Instructions: instructions,
		Localized:    true,
		Lang:         "en",
	}
}

// rustdeskReleaseFile builds the GitHub release download URL for a pinned
// version, so the default buttons stay stable until explicitly bumped.
func rustdeskReleaseFile(asset string) string {
	return "https://github.com/rustdesk/rustdesk/releases/download/" + DefaultRustDeskVersion + "/" + asset
}

// defaultDownloadButtons mirrors the assets published for RustDesk 1.4.9.
// Platforms without native build assets (iOS ships via the App Store) get none.
func defaultDownloadButtons(platform string) []DownloadButton {
	var buttons []DownloadButton
	add := func(name, asset string) {
		buttons = append(buttons, DownloadButton{Name: name, URL: rustdeskReleaseFile(asset), Enabled: true})
	}
	switch platform {
	case "windows":
		add("Windows x86_64 (.exe)", "rustdesk-1.4.9-x86_64.exe")
		add("Windows ARM64 (.exe)", "rustdesk-1.4.9-aarch64.exe")
		add("Windows 32-bit (.exe)", "rustdesk-1.4.9-x86-sciter.exe")
		add("Windows MSI", "rustdesk-1.4.9-x86_64.msi")
	case "macos":
		add("macOS Intel (x86_64)", "rustdesk-1.4.9-x86_64.dmg")
		add("macOS Apple Silicon (ARM64)", "rustdesk-1.4.9-aarch64.dmg")
	case "linux":
		add("Linux x86_64 (.deb)", "rustdesk-1.4.9-x86_64.deb")
		add("Linux ARM64 (.deb)", "rustdesk-1.4.9-aarch64.deb")
		add("Linux x86_64 (.rpm)", "rustdesk-1.4.9-x86_64.rpm")
		add("Linux ARM64 (.rpm)", "rustdesk-1.4.9-aarch64.rpm")
		add("Linux x86_64 (AppImage)", "rustdesk-1.4.9-x86_64.AppImage")
		add("Linux ARM64 (AppImage)", "rustdesk-1.4.9-aarch64.AppImage")
		add("Linux x86_64 (Flatpak)", "rustdesk-1.4.9-x86_64.flatpak")
	case "android":
		add("Android (universal APK)", "rustdesk-1.4.9-universal-signed.apk")
		add("Android ARM64 (APK)", "rustdesk-1.4.9-aarch64-signed.apk")
		add("Android ARMv7 (APK)", "rustdesk-1.4.9-armv7-signed.apk")
		add("Android x86_64 (APK)", "rustdesk-1.4.9-x86_64-signed.apk")
	}
	if buttons == nil {
		return []DownloadButton{}
	}
	return buttons
}

// GetDownloadPageConfig loads the stored config, merging it over the default
// so saved platforms are never lost when new ones are added on upgrades.
func (s *Store) GetDownloadPageConfig(ctx context.Context) DownloadPageConfig {
	cfg := DefaultDownloadPageConfig()
	raw, err := s.Get(ctx, DownloadPageConfigKey, "")
	if err != nil || raw == "" {
		return cfg
	}
	var stored DownloadPageConfig
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return cfg
	}
	return mergeDownloadPageConfig(cfg, stored)
}

// mergeDownloadPageConfig fills any missing platform entries from the built-in
// defaults and guarantees an initialized screenshots and instructions map. A
// language slot without a button list for a platform gets the default buttons;
// an explicitly empty (present) list is never overwritten.
func mergeDownloadPageConfig(base, stored DownloadPageConfig) DownloadPageConfig {
	if stored.Platforms == nil {
		stored.Platforms = map[string]PlatformPageConfig{}
	}
	for _, k := range KnownDownloadPlatforms {
		p, ok := stored.Platforms[k]
		if !ok {
			if stored.Platforms == nil {
				stored.Platforms = map[string]PlatformPageConfig{}
			}
			stored.Platforms[k] = base.Platforms[k]
			continue
		}
		if p.Buttons == nil {
			p.Buttons = map[string][]DownloadButton{}
		}
		for _, lang := range SupportedDownloadLangs {
			if p.Buttons[lang] == nil {
				p.Buttons[lang] = base.Platforms[k].Buttons[lang]
			}
		}
		stored.Platforms[k] = p
	}
	if stored.Screenshots == nil {
		stored.Screenshots = []ScreenshotEntry{}
	}
	if stored.Instructions == nil {
		stored.Instructions = map[string][]Instruction{}
	}
	for _, lang := range SupportedDownloadLangs {
		if stored.Instructions[lang] == nil {
			stored.Instructions[lang] = []Instruction{}
		}
	}
	return stored
}

// SaveDownloadPageConfig validates and stores the config.
func (s *Store) SaveDownloadPageConfig(ctx context.Context, cfg DownloadPageConfig) error {
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		return err
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return s.Set(ctx, DownloadPageConfigKey, string(data))
}

// langAt picks a language value or "" for an unknown/blank slot.
func langAt(l LangStrings, lang string) string {
	switch lang {
	case "en":
		return l.En
	case "ru":
		return l.Ru
	case "zh":
		return l.Zh
	case "ar":
		return l.Ar
	}
	return ""
}

func containsLang(lang string) bool {
	for _, known := range SupportedDownloadLangs {
		if lang == known {
			return true
		}
	}
	return false
}

// ValidateDownloadPageConfig enforces lengths and shapes so random junk can
// not be stored. Empty text fields are always allowed (built-in defaults).
func ValidateDownloadPageConfig(cfg DownloadPageConfig) error {
	if cfg.Platforms == nil {
		return errors.New("platforms must be present")
	}
	if len(cfg.Screenshots) > 20 {
		return errors.New("too many screenshots (max 20)")
	}
	if cfg.Lang != "" && !containsLang(cfg.Lang) {
		return fmt.Errorf("unknown page language %q", cfg.Lang)
	}
	for name, ll := range map[string]LangStrings{
		"title":             cfg.Title,
		"subtitle":          cfg.Subtitle,
		"intro":             cfg.Intro,
		"instructionsTitle": cfg.InstructionsTitle,
	} {
		for _, lang := range SupportedDownloadLangs {
			v := strings.TrimSpace(langAt(ll, lang))
			limit := 300
			if name == "intro" {
				limit = 4000
			}
			if len(v) > limit {
				return fmt.Errorf("%s (%s) is too long", name, lang)
			}
		}
	}
	for key, p := range cfg.Platforms {
		if !validPlatformKey(key) {
			return fmt.Errorf("unknown platform %q", key)
		}
		for lang, list := range p.Buttons {
			if !containsLang(lang) {
				return fmt.Errorf("platform %s has unknown language %q", key, lang)
			}
			if len(list) > 30 {
				return fmt.Errorf("too many buttons for %s (%s) (max 30)", key, lang)
			}
			for _, b := range list {
				if len(b.Name) > 120 {
					return fmt.Errorf("button name for %s (%s) is too long", key, lang)
				}
				if len(b.URL) > 500 {
					return fmt.Errorf("button url for %s (%s) is too long", key, lang)
				}
				if b.URL != "" && !isHTTPURL(b.URL) {
					return fmt.Errorf("button url for %s (%s) must start with http:// or https://", key, lang)
				}
			}
		}
		if p.Buttons == nil {
			p.Buttons = map[string][]DownloadButton{}
		}
		for _, lang := range SupportedDownloadLangs {
			v := strings.TrimSpace(langAt(p.Instructions, lang))
			if len(v) > 4000 {
				return fmt.Errorf("instructions (%s) for %s are too long", lang, key)
			}
		}
		cfg.Platforms[key] = p
	}
	for _, s := range cfg.Screenshots {
		if len(s.URL) > 500 {
			return errors.New("screenshot URL is too long")
		}
		if s.URL != "" && !isScreenshotURL(s.URL) {
			return errors.New("screenshot URL must be http(s) or start with /api/client/screenshots/")
		}
	}
	for lang, insList := range cfg.Instructions {
		if !containsLang(lang) {
			return fmt.Errorf("unknown instruction language %q", lang)
		}
		if len(insList) > 100 {
			return fmt.Errorf("too many instructions in %s (max 100)", lang)
		}
		seen := map[string]bool{}
		for i, ins := range insList {
			id := strings.TrimSpace(ins.ID)
			if id == "" {
				return fmt.Errorf("instruction id in %s must be present", lang)
			}
			if len(id) > 64 {
				return errors.New("instruction id is too long")
			}
			if seen[id] {
				return fmt.Errorf("duplicate instruction id %q in %s", id, lang)
			}
			seen[id] = true
			if ins.Target != "" && !validPlatformKey(ins.Target) {
				return fmt.Errorf("instruction %d in %s has unknown target %q", i, lang, ins.Target)
			}
			if ins.Color != "" && !validInstructionButtonColor(ins.Color) {
				return fmt.Errorf("instruction %d in %s has unknown button color %q", i, lang, ins.Color)
			}
			if v := strings.TrimSpace(ins.Title); len(v) > 200 {
				return fmt.Errorf("instruction %d title in %s is too long", i, lang)
			}
			if len(ins.Steps) > 50 {
				return fmt.Errorf("too many steps in instruction %d in %s (max 50)", i, lang)
			}
			for j, step := range ins.Steps {
				if v := strings.TrimSpace(step.Text); len(v) > 4000 {
					return fmt.Errorf("step %d text in %s is too long", j, lang)
				}
				if len(step.ImagesLight) > 3 {
					return fmt.Errorf("step %d in %s has too many light-theme images (max 3)", j, lang)
				}
				if len(step.ImagesDark) > 3 {
					return fmt.Errorf("step %d in %s has too many dark-theme images (max 3)", j, lang)
				}
				for _, images := range [][]string{step.ImagesLight, step.ImagesDark} {
					for _, u := range images {
						if len(u) > 500 {
							return errors.New("step image URL is too long")
						}
						if u != "" && !isScreenshotURL(u) {
							return errors.New("step image URL must be http(s) or start with /api/client/screenshots/")
						}
					}
				}
				if len(step.Buttons) > 10 {
					return fmt.Errorf("step %d in %s has too many buttons (max 10)", j, lang)
				}
				for _, b := range step.Buttons {
					if v := strings.TrimSpace(b.Text); len(v) > 120 {
						return fmt.Errorf("step %d button text in %s is too long", j, lang)
					}
					if len(b.URL) > 500 {
						return fmt.Errorf("step %d button url in %s is too long", j, lang)
					}
					if b.URL != "" && !isHTTPURL(b.URL) {
						return fmt.Errorf("step %d button url in %s must start with http:// or https://", j, lang)
					}
				}
			}
		}
	}
	return nil
}

func validPlatformKey(k string) bool {
	for _, known := range KnownDownloadPlatforms {
		if k == known {
			return true
		}
	}
	return false
}

func validInstructionButtonColor(c string) bool {
	if c == "" {
		return true
	}
	for _, known := range KnownInstructionButtonColors {
		if c == known {
			return true
		}
	}
	// Custom colors are stored as #rrggbb hex.
	return isHexColor(c)
}

func isHexColor(c string) bool {
	if len(c) != 7 || c[0] != '#' {
		return false
	}
	for i := 1; i < len(c); i++ {
		if !(c[i] >= '0' && c[i] <= '9') && !(c[i] >= 'a' && c[i] <= 'f') && !(c[i] >= 'A' && c[i] <= 'F') {
			return false
		}
	}
	return true
}

func isHTTPURL(v string) bool {
	return strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://")
}

func isScreenshotURL(v string) bool {
	if isHTTPURL(v) {
		return true
	}
	return strings.HasPrefix(v, "/api/client/screenshots/") && !strings.Contains(v, "..")
}

// ScreenshotStorageName returns a random, collision-safe filename for an
// uploaded screenshot preserving its original extension.
func ScreenshotStorageName(ext string) (string, error) {
	ext = strings.ToLower(ext)
	if !AllowedScreenshotExts[ext] {
		return "", fmt.Errorf("unsupported image type %q (allowed: png, jpg, jpeg, webp, gif)", ext)
	}
	randBytes := make([]byte, 8)
	if _, err := rand.Read(randBytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%x%s", time.Now().UTC().Format("20060102T150405"), randBytes, ext), nil
}

// ResolveScreenshotPath confirms name is a plain basename and joins it into
// dir, rejecting path traversal attempts.
func ResolveScreenshotPath(dir, name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		return "", errors.New("invalid screenshot file name")
	}
	return filepath.Join(dir, name), nil
}
