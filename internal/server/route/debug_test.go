package route

import "testing"

func TestControllerDebugRequiresInjectedSinkAndRoom(t *testing.T) {
	var kinds, events []string
	sink := func(kind string, args ...any) {
		kinds = append(kinds, kind)
		if len(args) >= 2 {
			if event, ok := args[1].(string); ok {
				events = append(events, event)
			}
		}
	}
	c := &Controller{debugRoomID: "1234", debugLog: sink}
	c.debug("operation-started", "child", "viewer-1")
	if len(kinds) != 1 || kinds[0] != "piik-route" ||
		len(events) != 1 || events[0] != "operation-started" {
		t.Fatalf("injected sink received kinds=%v events=%v", kinds, events)
	}
	(&Controller{debugRoomID: "1234"}).debug("no-sink")
	(&Controller{debugLog: sink}).debug("no-room")
	if len(kinds) != 1 {
		t.Fatalf("disabled controller emitted %v", kinds)
	}
}
