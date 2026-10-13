//go:build linux

package app

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

func TestTrayActivationReopensTheCurrentEntry(t *testing.T) {
	opened := make(chan string, 2)
	console := newConsole(func() {}, true)
	console.openURL = func(target string) error { opened <- target; return nil }
	console.show(consoleView{entry: "http://127.0.0.1:41291/client"})
	console.show(consoleView{entry: "http://127.0.0.1:8787/#piik-client=1"})
	item := trayItem{open: console.reopenBrowser}
	item.Activate(0, 0)
	select {
	case target := <-opened:
		if target != "http://127.0.0.1:8787/#piik-client=1" {
			t.Fatalf("opened retired entry: %s", target)
		}
	case <-time.After(time.Second):
		t.Fatal("activation did not reopen page")
	}
}

// Opt-in physical desktop check: registration, Plasma activation and removal.
func TestLinuxTrayIntegration(t *testing.T) {
	if os.Getenv("PIIK_TRAY_GATE") != "true" {
		t.Skip("requires a live StatusNotifier desktop")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	opened := make(chan struct{}, 1)
	closeTray, err := startTray(ctx, func() { opened <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	defer closeTray()
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var service string
	for service == "" {
		value, err := conn.Object(trayWatcher, "/StatusNotifierWatcher").GetProperty(trayWatcher + ".RegisteredStatusNotifierItems")
		if err != nil {
			t.Fatal(err)
		}
		items, ok := value.Value().([]string)
		if !ok {
			t.Fatalf("unexpected watcher items: %T", value.Value())
		}
		for _, item := range items {
			for i := 0; i < len(item); i++ {
				if item[i] == '/' {
					candidate := item[:i]
					id, err := conn.Object(candidate, trayPath).GetProperty(trayInterface + ".Id")
					if err == nil && id.Value() == "piik-app" {
						service = candidate
					}
					break
				}
			}
		}
		if service == "" {
			select {
			case <-ctx.Done():
				t.Fatal("tray not registered")
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	if err := conn.Object(service, trayPath).CallWithContext(ctx, trayInterface+".Activate", 0, int32(0), int32(0)).Err; err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("activation callback missing")
	}
	closeTray()
	if err := conn.Object(service, trayPath).CallWithContext(ctx, trayInterface+".Activate", 0, int32(0), int32(0)).Err; err == nil {
		t.Fatal("closed tray still callable")
	}
}
