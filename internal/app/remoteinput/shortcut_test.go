package remoteinput

import (
	"errors"
	"testing"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

func TestStopShortcutCollisionAndReplacement(t *testing.T) {
	registered := map[int]bool{10: true}
	saved := appconfig.DefaultRemoteStopKey
	failSave := false
	m := &Manager{sink: &recordedInput{}, connections: map[endpointKey]*connection{}, stopKey: saved}
	m.registerStop = func(key int) (func(), error) {
		if registered[key] {
			return nil, errors.New("occupied")
		}
		registered[key] = true
		return func() { delete(registered, key) }, nil
	}
	m.saveStopKey = func(key int) error {
		if failSave {
			return errors.New("read-only configuration")
		}
		saved = key
		return nil
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
	if err := setTestPolicy(s, "ask", ""); err != nil || s.State().Mode != "ask" || saved != 9 {
		t.Fatalf("changing the shortcut did not recover the same backend: %v", err)
	}
	if _, err := m.SetStopShortcut(10); err == nil || !registered[9] || m.stopKey != 9 {
		t.Fatal("a collision retired the working shortcut")
	}
	failSave = true
	if _, err := m.SetStopShortcut(8); err == nil || registered[8] || !registered[9] || m.stopKey != 9 {
		t.Fatal("a failed save changed or leaked the shortcut")
	}
	m.Close()
	if registered[9] || !registered[10] {
		t.Fatal("shutdown leaked or released another owner's shortcut")
	}
}
