package settings

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateDownloadPageConfigDefaultsAccepted(t *testing.T) {
	if err := ValidateDownloadPageConfig(DefaultDownloadPageConfig()); err != nil {
		t.Fatalf("default config should be valid: %v", err)
	}
}

func TestValidateDownloadPageConfigRejectsUnknownPlatform(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	cfg.Platforms["watchos"] = PlatformPageConfig{Enabled: true}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an unknown platform key")
	}
}

func TestValidateDownloadPageConfigRejectsMissingPlatforms(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	cfg.Platforms = nil
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error when platforms is nil")
	}
}

func TestValidateDownloadPageConfigAcceptsStyling(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	p := cfg.Platforms["linux"]
	p.Buttons["en"] = []DownloadButton{{Name: "GitHub release", URL: "https://github.com/rustdesk/rustdesk/releases", Enabled: true}}
	cfg.Platforms["linux"] = p
	cfg.Title.Ru = "Скачать"
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestValidateDownloadPageConfigRejectsTraversalScreenshot(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	cfg.Screenshots = []ScreenshotEntry{{ID: "a", URL: "/api/client/screenshots/../secret.png"}}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for a traversal screenshot URL")
	}
}

func TestScreenshotStorageNameExtensionFiltering(t *testing.T) {
	if _, err := ScreenshotStorageName(".PNG"); err != nil {
		t.Fatalf("case-insensitive extension should be accepted: %v", err)
	}
	if _, err := ScreenshotStorageName(".svg"); err == nil {
		t.Fatal("expected an error for disallowed extension")
	}
}

func TestResolveScreenshotPathRejectsTraversal(t *testing.T) {
	for _, name := range []string{".", "..", "a/b.png", "../x.png", ".hidden"} {
		if _, err := ResolveScreenshotPath("/screenshots", name); err == nil {
			t.Fatalf("expected an error for %q", name)
		}
	}
	p, err := ResolveScreenshotPath("/screenshots", "shot.png")
	if err != nil || p != "/screenshots/shot.png" {
		t.Fatalf("unexpected resolution: %q, %v", p, err)
	}
}

func TestGetDownloadPageConfigReturnsDefaultsWhenEmpty(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	for _, k := range KnownDownloadPlatforms {
		if !cfg.Platforms[k].Enabled {
			t.Fatalf("default platform %s should be enabled", k)
		}
	}
	if !cfg.Localized {
		t.Fatal("default config should be localized")
	}
	if cfg.Lang != "en" {
		t.Fatalf("default page language should be en, got %q", cfg.Lang)
	}
	for _, lang := range SupportedDownloadLangs {
		if len(cfg.Instructions[lang]) != 0 {
			t.Fatalf("default %s instructions should be empty", lang)
		}
	}
}

func TestGetDownloadPageConfigMergesNewPlatforms(t *testing.T) {
	stored := DefaultDownloadPageConfig()
	p := stored.Platforms["windows"]
	p.Enabled = false
	stored.Platforms["windows"] = p
	got := mergeDownloadPageConfig(DefaultDownloadPageConfig(), stored)
	if got.Platforms["windows"].Enabled {
		t.Fatal("stored windows disabled state lost")
	}
	if !got.Platforms["linux"].Enabled {
		t.Fatal("default linux entry should survive merge")
	}
	if len(got.Screenshots) != 0 {
		t.Fatalf("expected empty screenshots, got %d", len(got.Screenshots))
	}
}

func TestMergeDownloadPageConfigFillsMissingPlatforms(t *testing.T) {
	stored := DownloadPageConfig{
		Platforms: map[string]PlatformPageConfig{"windows": {Enabled: false}},
	}
	got := mergeDownloadPageConfig(DefaultDownloadPageConfig(), stored)
	if len(got.Platforms) != len(KnownDownloadPlatforms) {
		t.Fatalf("expected %d platforms, got %d", len(KnownDownloadPlatforms), len(got.Platforms))
	}
	for _, k := range KnownDownloadPlatforms {
		if _, ok := got.Platforms[k]; !ok {
			t.Fatalf("platform %s missing after merge", k)
		}
	}
}

func TestValidateDownloadPageConfigRejectsOversizedIntro(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	cfg.Intro.Ru = strings.Repeat("ф", 4001)
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an oversized intro")
	}
}

func TestDefaultDownloadPageConfigSeedsButtons(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	if len(cfg.Platforms["windows"].Buttons["en"]) < 2 {
		t.Fatalf("windows should have seeded download buttons, got %d", len(cfg.Platforms["windows"].Buttons["en"]))
	}
	if len(cfg.Platforms["ios"].Buttons["ru"]) != 0 {
		t.Fatal("ios should have no default buttons (App Store only)")
	}
	for _, lang := range SupportedDownloadLangs {
		for _, k := range KnownDownloadPlatforms {
			for _, b := range cfg.Platforms[k].Buttons[lang] {
				if b.URL == "" || !isHTTPURL(b.URL) {
					t.Fatalf("default button %q for %s (%s) has an invalid url %q", b.Name, k, lang, b.URL)
				}
				if !b.Enabled {
					t.Fatalf("default button %q for %s (%s) should be visible", b.Name, k, lang)
				}
			}
		}
	}
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("defaults with buttons should be valid: %v", err)
	}
}

func TestMergeDownloadPageConfigFillsDefaultButtons(t *testing.T) {
	stored := DownloadPageConfig{
		Platforms: map[string]PlatformPageConfig{
			"windows": {Enabled: true},
			"linux":   {Enabled: false},
		},
	}
	got := mergeDownloadPageConfig(DefaultDownloadPageConfig(), stored)
	if len(got.Platforms["windows"].Buttons["en"]) == 0 {
		t.Fatal("old stored platform without buttons should get default buttons")
	}
	if got.Platforms["linux"].Enabled {
		t.Fatal("stored disabled state was lost")
	}
	if len(got.Platforms["linux"].Buttons["en"]) == 0 {
		t.Fatal("old stored platform should also get default buttons")
	}
}

func TestMergeDownloadPageConfigPreservesEmptyButtons(t *testing.T) {
	stored := DownloadPageConfig{
		Platforms: map[string]PlatformPageConfig{
			"windows": {Enabled: true, Buttons: map[string][]DownloadButton{
				"en": []DownloadButton{},
			}},
		},
	}
	got := mergeDownloadPageConfig(DefaultDownloadPageConfig(), stored)
	if len(got.Platforms["windows"].Buttons["en"]) != 0 {
		t.Fatal("an explicitly empty button list must be preserved, not refilled")
	}
	for _, lang := range SupportedDownloadLangs {
		if lang == "en" {
			continue
		}
		if len(got.Platforms["windows"].Buttons[lang]) == 0 {
			t.Fatalf("missing language %s should be refilled with defaults", lang)
		}
	}
}

func TestValidateDownloadPageConfigRejectsBadButtonURL(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	p := cfg.Platforms["windows"]
	p.Buttons["en"] = []DownloadButton{{Name: "Down", URL: "rustdesk.com/file.exe", Enabled: true}}
	cfg.Platforms["windows"] = p
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for a button url without scheme")
	}
}

func TestValidateDownloadPageConfigRejectsTooManyButtons(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	p := cfg.Platforms["linux"]
	p.Buttons["en"] = []DownloadButton{}
	for i := 0; i < 31; i++ {
		p.Buttons["en"] = append(p.Buttons["en"], DownloadButton{Name: "b", URL: "https://example.com"})
	}
	cfg.Platforms["linux"] = p
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 31 buttons on one platform")
	}
}

func TestValidateDownloadPageConfigRejectsOversizedButtonName(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	p := cfg.Platforms["android"]
	p.Buttons["en"] = []DownloadButton{{Name: strings.Repeat("н", 121), URL: "https://example.com", Enabled: true}}
	cfg.Platforms["android"] = p
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an oversized button name")
	}
}

func TestValidateDownloadPageConfigRejectsUnknownButtonLanguage(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	p := cfg.Platforms["windows"]
	p.Buttons["de"] = []DownloadButton{{Name: "b", URL: "https://example.com", Enabled: true}}
	cfg.Platforms["windows"] = p
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an unknown button language key")
	}
}

func sampleInstruction(stepCount, imageCount int) Instruction {
	steps := []InstructionStep{}
	for i := 0; i < stepCount; i++ {
		step := InstructionStep{Text: "Step text", Buttons: []StepButton{}}
		for j := 0; j < imageCount; j++ {
			step.ImagesLight = append(step.ImagesLight, "/api/client/screenshots/shot.png")
		}
		steps = append(steps, step)
	}
	return Instruction{ID: "guide-1", Title: "Setup", Steps: steps}
}

func withInstructions(cfg DownloadPageConfig, lang string, list []Instruction) DownloadPageConfig {
	cfg.Instructions[lang] = list
	return cfg
}

func TestValidateDownloadPageConfigAcceptsInstructionTargetAndColor(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Target = "windows"
	ins.Color = "green"
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("targeted instruction with a preset color should be valid: %v", err)
	}
}

func TestValidateDownloadPageConfigRejectsUnknownInstructionTarget(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Target = "watchos"
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an unknown instruction target")
	}
}

func TestValidateDownloadPageConfigRejectsUnknownInstructionColor(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Color = "neon"
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an unknown instruction button color")
	}
}

func TestValidateDownloadPageConfigAcceptsHexInstructionColor(t *testing.T) {
	for _, color := range []string{"#00ff88", "#123456", "#ABCDEF"} {
		cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
		ins := sampleInstruction(1, 0)
		ins.Color = color
		cfg.Instructions["en"] = []Instruction{ins}
		if err := ValidateDownloadPageConfig(cfg); err != nil {
			t.Fatalf("hex color %q should be valid: %v", color, err)
		}
	}
}

func TestValidateDownloadPageConfigRejectsMalformedHexColor(t *testing.T) {
	for _, color := range []string{"#12345", "#1234567", "#zzzzzz", "123456", "blue-ish"} {
		cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
		ins := sampleInstruction(1, 0)
		ins.Color = color
		cfg.Instructions["en"] = []Instruction{ins}
		if err := ValidateDownloadPageConfig(cfg); err == nil {
			t.Fatalf("malformed color %q should be rejected", color)
		}
	}
}

func TestDefaultDownloadPageConfigSetsPlatformOrder(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	for i, k := range KnownDownloadPlatforms {
		if cfg.Platforms[k].Order != i {
			t.Fatalf("default order for %s should be %d, got %d", k, i, cfg.Platforms[k].Order)
		}
	}
}

func TestValidateDownloadPageConfigAcceptsInstructions(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	cfg.Instructions["en"] = []Instruction{
		sampleInstruction(3, 3),
		{ID: "guide-2", Title: "Android", Steps: []InstructionStep{
			{Text: "Install", Buttons: []StepButton{{Text: "Open", URL: "https://example.com"}}},
		}},
	}
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("instruction builder config should be valid: %v", err)
	}
}

func TestMergeDownloadPageConfigInitializesInstructions(t *testing.T) {
	stored := DownloadPageConfig{Platforms: map[string]PlatformPageConfig{}}
	got := mergeDownloadPageConfig(DefaultDownloadPageConfig(), stored)
	if got.Instructions == nil {
		t.Fatal("merge should initialize an instructions map")
	}
	for _, lang := range SupportedDownloadLangs {
		if got.Instructions[lang] == nil {
			t.Fatalf("merge should initialize %s instructions slice", lang)
		}
	}
}

func TestValidateDownloadPageConfigRejectsUnknownInstructionLanguage(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	cfg.Instructions["de"] = []Instruction{sampleInstruction(1, 0)}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for an unknown instruction language key")
	}
}

func TestValidateDownloadPageConfigRejectsTooManyLightImagesPerStep(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	cfg.Instructions["en"] = []Instruction{sampleInstruction(1, 4)}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 4 light-theme images in one step")
	}
}

func TestValidateDownloadPageConfigRejectsTooManyDarkImagesPerStep(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Steps[0].ImagesDark = make([]string, 4)
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 4 dark-theme images in one step")
	}
}

func TestValidateDownloadPageConfigAcceptsImagesPerTheme(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 3)
	ins.Steps[0].ImagesDark = []string{"/api/client/screenshots/d1.png"}
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("3 light + 1 dark images should be valid: %v", err)
	}
}

func TestValidateDownloadPageConfigRejectsTraversalStepImage(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Steps[0].ImagesLight = []string{"/api/client/screenshots/../x.png"}
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for a traversal step image URL")
	}
}

func TestValidateDownloadPageConfigRejectsOversizedStepText(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Steps[0].Text = strings.Repeat("ф", 4001)
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for oversized step text")
	}
}

func TestValidateDownloadPageConfigRejectsDuplicateInstructionID(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	cfg.Instructions["en"] = []Instruction{sampleInstruction(1, 0), sampleInstruction(1, 0)}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for duplicate instruction ids")
	}
}

func TestValidateDownloadPageConfigRejectsTooManySteps(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	cfg.Instructions["en"] = []Instruction{sampleInstruction(51, 0)}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 51 steps in one instruction")
	}
}

func TestValidateDownloadPageConfigRejectsBadStepButtonURL(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	ins.Steps[0].Buttons = []StepButton{{Text: "Go", URL: "example.com/x"}}
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for a step button url without scheme")
	}
}

func TestValidateDownloadPageConfigRejectsTooManyStepButtons(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	ins := sampleInstruction(1, 0)
	for i := 0; i < 11; i++ {
		ins.Steps[0].Buttons = append(ins.Steps[0].Buttons, StepButton{Text: "b", URL: "https://example.com"})
	}
	cfg.Instructions["en"] = []Instruction{ins}
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 11 step buttons")
	}
}

func TestValidateDownloadPageConfigRejectsTooManyInstructions(t *testing.T) {
	cfg := withInstructions(DefaultDownloadPageConfig(), "en", []Instruction{})
	list := make([]Instruction, 0, 101)
	for i := 0; i < 101; i++ {
		list = append(list, Instruction{ID: fmt.Sprintf("g-%d", i), Title: "", Steps: []InstructionStep{}})
	}
	cfg.Instructions["en"] = list
	if err := ValidateDownloadPageConfig(cfg); err == nil {
		t.Fatal("expected an error for 101 instructions in one language")
	}
}

func TestValidateDownloadPageConfigAcceptsIndependentPerLanguageInstructions(t *testing.T) {
	cfg := DefaultDownloadPageConfig()
	cfg.Instructions["en"] = []Instruction{{ID: "en-1", Title: "English", Steps: []InstructionStep{}}}
	cfg.Instructions["ru"] = []Instruction{{ID: "ru-1", Title: "Русский", Steps: []InstructionStep{}}}
	if err := ValidateDownloadPageConfig(cfg); err != nil {
		t.Fatalf("independent per-language instruction sets should be valid: %v", err)
	}
	if len(cfg.Instructions["zh"]) != 0 {
		t.Fatal("untouched languages should stay empty")
	}
}
