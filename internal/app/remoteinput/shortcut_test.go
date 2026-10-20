package remoteinput

import (
	"errors"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

func TestStopShortcutCollisionAndReplacement(t *testing.T) {
	registered := map[int]bool{10: true}
	m := &Manager{sink: &recordedInput{}, connections: map[endpointKey]*connection{}, stopKey: defaultStopKey}
	m.registerStop = func(key int) (func(), error) {
		if registered[key] {
			return nil, errors.New("occupied")
		}
		registered[key] = true
		return func() { delete(registered, key) }, nil
	}
	t.Cleanup(m.Close)
	s := m.NewSession()
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	if err := setTestPolicy(s, "ask", ""); err == nil || s.State().Mode != "off" {
		t.Fatal("occupied shortcut enabled control")
	}
	state, err := m.ReadStopShortcut()
	if err != nil || state.Available || state.Key != 10 {
		t.Fatalf("collision was hidden: %+v, %v", state, err)
	}
	if _, err := m.SetStopShortcut(9); err != nil {
		t.Fatal(err)
	}
	if registered[9] {
		t.Fatal("idle configuration reserved the shortcut")
	}
	if err := setTestPolicy(s, "ask", ""); err != nil || s.State().Mode != "ask" || !registered[9] {
		t.Fatalf("changing the shortcut did not recover the same backend: %v", err)
	}
	if _, err := m.SetStopShortcut(10); err == nil || !registered[9] || m.stopKey != 9 {
		t.Fatal("a collision retired the working shortcut")
	}
	if _, err := m.SetStopShortcut(8); err != nil || !registered[8] || registered[9] || m.stopKey != 8 {
		t.Fatal("replacing the shortcut did not retire the old binding")
	}
	other := m.NewSession()
	other.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
	if err := setTestPolicy(other, "ask", ""); err != nil {
		t.Fatal(err)
	}
	if err := setTestPolicy(s, "off", ""); err != nil || !registered[8] {
		t.Fatal("disabling one session released another session's shortcut")
	}
	other.Close()
	if registered[8] {
		t.Fatal("closing the last enabled session retained the shortcut")
	}
	if err := setTestPolicy(s, "ask", ""); err != nil || !registered[8] {
		t.Fatalf("a later control session did not reacquire the shortcut: %v", err)
	}
	m.Close()
	if registered[8] || !registered[10] {
		t.Fatal("shutdown leaked or released another owner's shortcut")
	}
}
