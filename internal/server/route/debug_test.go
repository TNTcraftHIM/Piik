package route

import (
	"io"
	"log/slog"
	"testing"
)

func TestDebugUsesCurrentEnvironmentAndLogger(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	for value, want := range map[string]bool{"": false, "client": false, "route": true, "client, route": true} {
		t.Setenv("SCREENER_DEBUG", value)
		if got := debugEnabled(); got != want {
			t.Fatalf("debugEnabled with %q = %v, want %v", value, got, want)
		}
	}
	t.Setenv("SCREENER_DEBUG", "")
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug})))
	if !debugEnabled() {
		t.Fatal("the active diagnostic logger did not enable route events")
	}
}
