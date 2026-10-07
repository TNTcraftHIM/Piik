package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestQualityPreferencePersistsWithoutChangingAppConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	if _, err := LoadOrCreate(path); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	p, err := LoadQualityPreference(path)
	if err != nil || p.Read() != nil {
		t.Fatalf("initial preference: %v, %v", p.Read(), err)
	}
	quality := protocol.DefaultQualitySettings
	quality.Resolution, quality.ScreenAudioQuality = "1440p", "very-high"
	if err := p.Save(quality); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadQualityPreference(path)
	if err != nil || loaded.Read() == nil || *loaded.Read() != quality {
		t.Fatalf("restored: %v, %v", loaded.Read(), err)
	}
	copy := loaded.Read()
	copy.Resolution = "480p"
	if *loaded.Read() != quality {
		t.Fatal("caller modified stored settings")
	}
	current, _ := os.ReadFile(path)
	if string(current) != string(original) {
		t.Fatal("preference changed strict App configuration")
	}
	invalid := quality
	invalid.Resolution = "2160p"
	if p.Save(invalid) == nil || *p.Read() != quality {
		t.Fatal("invalid choice changed preference")
	}
	if err := os.Remove(path + ".quality"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".quality", 0700); err != nil {
		t.Fatal(err)
	}
	quality.Resolution = "720p"
	if p.Save(quality) == nil || p.Read().Resolution != "1440p" {
		t.Fatal("failed write replaced saved preference")
	}
}

func TestUnavailableQualityPreferenceCanAcceptTheNextChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	for _, payload := range []string{"null", "{}", "{", strings.Repeat(" ", MaxQualityPreferenceBytes+1)} {
		if err := os.WriteFile(path+".quality", []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		p, err := LoadQualityPreference(path)
		if err == nil || p == nil || p.Read() != nil {
			t.Fatalf("invalid preference: %v, %v", p, err)
		}
		if err := p.Save(protocol.DefaultQualitySettings); err != nil {
			t.Fatal(err)
		}
		if p.Read() == nil {
			t.Fatal("choice was not saved")
		}
	}
}
