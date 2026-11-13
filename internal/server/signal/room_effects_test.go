package signal

import (
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestLocalRoomEffectsUseCurrentHostAndShare(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 5000})
	events := make(chan RoomEffect, 12)
	h.locked(func() {
		h.server.localHostOrigin = h.http.URL
		h.server.allowedOrigins[h.http.URL] = struct{}{}
		h.server.localRoomEffect = func(event RoomEffect) { events <- event }
	})
	localHost := func() *testClient {
		conn, _, err := dialClient(t, h.wsURL, h.http.URL, "")
		if err != nil {
			t.Fatal(err)
		}
		return newTestClient(t, conn)
	}
	host := localHost()
	authenticate(t, host, h.room, protocol.RoleHost, "desktop_effect_host", 1, "",
		presenceOptions{roomSession: true, roomOnly: true, displayName: "房主"})
	subscribeInteractions(t, host)
	viewer := openClient(t, h)
	viewerOptions := presenceOptions{displayName: "小明"}
	authenticate(t, viewer, h.room, protocol.RoleViewer, "desktop_effect_viewer", 1, "", viewerOptions)
	arrival := nextRoomEffect(t, events, ViewerArrived, "小明")
	h.closeClient(viewer)
	viewer = openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "desktop_effect_viewer", 1, "", viewerOptions)
	subscribeInteractions(t, viewer)

	sendChat := func(id, text string) {
		t.Helper()
		viewer.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": id,
			"payload": map[string]any{"kind": "chat", "text": text}})
		host.next("room-interaction")
		viewer.next("room-interaction")
	}
	sendChat("desktop_effect_idle", "before sharing")
	select {
	case event := <-events:
		t.Fatalf("unexpected effect while idle or reconnecting: %+v", event)
	default:
	}

	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "desktop_effect_share",
		"routePolicy": protocol.DefaultRoutePolicy})
	host.next("sharing-started")
	time.Sleep(time.Duration(protocol.InteractionIntervalMs) * time.Millisecond)
	sendChat("desktop_effect_chat", "你好 Windows")
	chat := nextRoomEffect(t, events, ViewerChat, "你好 Windows")
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "desktop_effect_share"})
	select {
	case <-chat.Done:
	case <-time.After(time.Second):
		t.Fatal("stopping the share left desktop chat live")
	}
	select {
	case <-arrival.Done:
		t.Fatal("stopping the share retired room announcements")
	default:
	}
	h.closeClient(host)
	select {
	case <-arrival.Done:
	case <-time.After(time.Second):
		t.Fatal("closing the Host left announcements live")
	}

	remote := openClient(t, h)
	authenticate(t, remote, h.room, protocol.RoleHost, "desktop_effect_host", 1, "",
		presenceOptions{roomSession: true, roomOnly: true})
	other := openClient(t, h)
	authenticate(t, other, h.room, protocol.RoleViewer, "desktop_effect_other", 1, "", viewerOptions)
	select {
	case event := <-events:
		t.Fatalf("remote Host activated a local effect: %+v", event)
	default:
	}
}

func nextRoomEffect(t *testing.T, events <-chan RoomEffect, kind RoomEffectKind, text string) RoomEffect {
	t.Helper()
	select {
	case event := <-events:
		if event.Kind != kind || event.Text != text {
			t.Fatalf("unexpected room effect: %+v", event)
		}
		return event
	case <-time.After(time.Second):
		t.Fatal("room effect did not arrive")
		return RoomEffect{}
	}
}
