package remoteinput

import (
	"errors"
	"strings"
	"testing"
)

type textReleaseSink struct {
	*recordedInput
	reject bool
}

func (s *textReleaseSink) Apply(b bounds, event inputEvent) error {
	if s.reject && event.Type == "key" && !event.Down {
		return errors.New("text key release rejected")
	}
	return s.recordedInput.Apply(b, event)
}

func TestPartialTextOnlyRetriesRelease(t *testing.T) {
	sink := &textReleaseSink{recordedInput: &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}, reject: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	_, peers := coPlaySession(t, m, true)
	c := peers[0]
	sendTestInput(m, c, inputEvent{Type: "request"})
	grant := c.grant
	sendTestInput(m, c, inputEvent{Type: "text", Text: "once\nnever"})
	if c.grant != grant || !c.inputFailed || !m.pendingKeys["Enter"] {
		t.Fatal("text failure changed grant or lost release debt")
	}
	if event := <-sink.events; event.Text != "once" {
		t.Fatal("text prefix was not delivered")
	}
	if event := <-sink.events; event.Code != "Enter" || !event.Down {
		t.Fatal("text did not execute newline press")
	}
	sink.reject = false
	m.retryReleases()
	if len(sink.events) != 1 {
		t.Fatal("text failure replayed a text fragment")
	}
	if event := <-sink.events; event.Code != "Enter" || event.Down {
		t.Fatal("text recovery did not restrict itself to release")
	}
}

func TestRejectedInputKeepsGrantAndDoesNotReplay(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "shared"}[shared], func(t *testing.T) {
			sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
			m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
			s, peers := coPlaySession(t, m, true)
			s.coPlay = shared
			c := peers[0]
			sendTestInput(m, c, inputEvent{Type: "request"})
			grant := c.grant
			sink.applyErr = errors.New("temporarily rejected")
			sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
			if grant == "" || c.grant != grant || !c.inputFailed || len(c.keys) != 0 {
				t.Fatal("failed press changed grant or became held")
			}
			sink.applyErr = nil
			m.retryReleases()
			if len(sink.events) != 0 {
				t.Fatal("failed press was replayed")
			}
			sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyB", Down: true})
			if c.grant != grant || c.inputFailed || !c.keys["KeyB"] {
				t.Fatal("new input did not recover within grant")
			}
			<-sink.events
			sink.applyErr = errors.New("release rejected")
			sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyB"})
			if c.grant != grant || !m.pendingKeys["KeyB"] || c.keys["KeyB"] {
				t.Fatal("failed release lost cleanup debt or grant")
			}
			if err := m.applyHeld(c, bounds{}, inputEvent{Type: "move", X: .7, Y: .4}); !errors.Is(err, sink.applyErr) || !strings.Contains(err.Error(), "key release retry") {
				t.Fatalf("cleanup hid the rejected release: %v", err)
			}
			if len(sink.events) != 0 {
				t.Fatal("new action ran before cleanup")
			}
			sink.resetErr = errors.New("reset blocked")
			m.releaseConnection(c)
			if c.grant != "" || !m.pendingKeys["KeyB"] {
				t.Fatal("retirement lost pending release")
			}
			sink.applyErr = nil
			sink.resetErr = nil
			m.retryReleases()
			if len(m.pendingKeys) != 0 || len(sink.events) != 1 {
				t.Fatal("retired release did not recover")
			}
			if event := <-sink.events; event.Type != "key" || event.Code != "KeyB" || event.Down {
				t.Fatalf("cleanup replayed action: %+v", event)
			}
		})
	}
}

func TestPlayerCleanupFailurePreservesSiblingGrant(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s, peers := coPlaySession(t, m, true, true)
	a, b := peers[0], peers[1]
	for _, c := range peers {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	grant := b.grant
	sendTestInput(m, a, inputEvent{Type: "button", Button: 0, Down: true})
	<-sink.events
	sink.applyErr = errors.New("release blocked")
	sendTestInput(m, a, inputEvent{Type: "reset"})
	if a.grant == "" || b.grant != grant || !a.inputFailed || !m.pendingButtons[0] {
		t.Fatal("personal reset changed authority or lost release")
	}
	m.releaseConnection(a)
	if b.grant != grant || m.owner != s {
		t.Fatal("disconnect cleanup revoked sibling")
	}
	if err := m.applyHeld(b, bounds{}, inputEvent{Type: "move", X: .5, Y: .5}); !errors.Is(err, sink.applyErr) || !strings.Contains(err.Error(), "button release retry") {
		t.Fatalf("shared cleanup hid the rejected button release: %v", err)
	}
	sink.applyErr = nil
	m.retryReleases()
	if event := <-sink.events; event.Type != "button" || event.Down {
		t.Fatal("cleanup replayed press")
	}
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyW", Down: true})
	<-sink.events
	sink.resetErr = errors.New("focus cleanup blocked")
	sink.focused = false
	m.refreshActive()
	if b.grant != grant || !b.suspended || !m.pendingKeys["KeyW"] {
		t.Fatal("focus cleanup lost grant or release debt")
	}
	m.retryReleases()
	if event := <-sink.events; event.Code != "KeyW" || event.Down {
		t.Fatal("focus cleanup replayed press")
	}
	sink.resetErr = nil
	sink.focused = true
	m.refreshActive()
	if b.grant != grant || b.suspended || len(sink.events) != 0 {
		t.Fatal("focus return changed grant or replayed action")
	}
}
