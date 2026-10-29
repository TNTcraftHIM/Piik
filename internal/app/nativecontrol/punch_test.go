package nativecontrol

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/P4-aaaul/Silip/internal/app/loopback"
	"github.com/P4-aaaul/Silip/internal/app/nativecapture"
)

func TestPunchResponseBackpressureBoundsWorkers(t *testing.T) {
	session := New("", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	viewer, err := session.ensureViewer("review_share", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := viewer.BeginPunch("review_connection", "", nil, strings.Repeat("42", 32)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < cap(session.events); i++ {
		session.events <- struct{}{}
	}
	const run = `{"version":10,"id":"run_request","type":"run-punch","shareId":"review_share","connectionId":"review_connection","prediction":{"address":"198.51.100.1","port":5000,"step":0}}`
	if value, err := session.Handle(t.Context(), []byte(run)); err != nil || value != nil {
		t.Fatalf("first probe was not admitted: %#v, %v", value, err)
	}
	session.mu.Lock()
	done := session.punchDone
	session.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ineligible probe did not finish")
	}
	for i := 0; i < 512; i++ {
		value, err := session.Handle(t.Context(), []byte(run))
		if _, failed := value.(requestFailedResponse); err != nil || !failed {
			t.Fatalf("duplicate probe escaped response admission: %#v, %v", value, err)
		}
	}
	if _, err := session.Handle(t.Context(), []byte(`{"version":10,"id":"close_request","type":"close-punch","shareId":"review_share","connectionId":"review_connection"}`)); err != nil {
		t.Fatal(err)
	}
	if viewer.Punch("review_connection") != nil {
		t.Fatal("response backpressure blocked preparation retirement")
	}
	// Draining the response permits the next phase/attempt; it is not a session failure.
	for i := 0; i < cap(session.events); i++ {
		<-session.events
	}
	var completion loopback.ControlEvent
	select {
	case event := <-session.events:
		completion = event.(loopback.ControlEvent)
		deliveredControlValue(completion)
	case <-time.After(time.Second):
		t.Fatal("probe completion was not delivered")
	}
	if value, err := session.Handle(t.Context(), []byte(`{"version":10,"id":"prepare_request","type":"prepare-punch","shareId":"review_share","connectionId":"next_connection","iceServers":[],"secret":"`+strings.Repeat("42", 32)+`","edgeCapacity":1}`)); err != nil || value != nil {
		t.Fatalf("next preparation was not admitted: %#v, %v", value, err)
	}
	completion.BeforeWrite()
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.punchDone == nil {
		t.Fatal("old completion released its successor's admission")
	}
}

func TestPunchPreparationPreservesMediaRole(t *testing.T) {
	for _, sourceID := range []string{"", "retired_receiver"} {
		t.Run("sender/"+sourceID, func(t *testing.T) {
			session := New("", nativecapture.Capabilities{}, false, nil)
			t.Cleanup(func() { _ = session.Close() })
			request := preparePunchRequest{
				requestEnvelope: requestEnvelope{Version: 10, ID: "prepare_request", Type: "prepare-punch"},
				ShareID:         "retired_share", ConnectionID: "new_connection", SourceConnectionID: sourceID,
				Secret: strings.Repeat("42", 32),
			}
			payload, _ := json.Marshal(request)
			value, err := session.Handle(t.Context(), payload)
			if _, failed := value.(requestFailedResponse); err != nil || !failed {
				t.Fatalf("missing sender must fail only its request: %#v, %v", value, err)
			}
			if session.currentViewer(request.ShareID) != nil {
				t.Fatal("late sender preparation installed a Viewer role")
			}
		})
	}
	t.Run("receiver", func(t *testing.T) {
		session := New("", nativecapture.Capabilities{}, false, nil)
		t.Cleanup(func() { _ = session.Close() })
		capacity := 2
		request := preparePunchRequest{
			requestEnvelope: requestEnvelope{Version: 10, ID: "prepare_request", Type: "prepare-punch"},
			ShareID:         "receiving_share", ConnectionID: "new_connection", EdgeCapacity: &capacity,
			Secret: strings.Repeat("42", 32),
		}
		payload, _ := json.Marshal(request)
		if _, err := session.Handle(t.Context(), payload); err != nil {
			t.Fatal(err)
		}
		if session.currentViewer(request.ShareID) == nil {
			t.Fatal("explicit receiving preparation did not install its Viewer role")
		}
	})
}

func TestPunchRequiresExplicitMappingStep(t *testing.T) {
	for _, step := range []string{"", `,"step":null`, `,"step":0`} {
		t.Run(step, func(t *testing.T) {
			session := New("", nativecapture.Capabilities{}, false, nil)
			t.Cleanup(func() { _ = session.Close() })
			payload := []byte(`{"version":10,"id":"run_request","type":"run-punch","shareId":"share_id",` +
				`"connectionId":"connection","prediction":{"address":"198.51.100.1","port":5000` + step + `}}`)
			result, err := session.Handle(t.Context(), payload)
			if step != `,"step":0` {
				if err == nil {
					t.Fatal("missing or null step accepted as a stable observation")
				}
			} else if _, failed := result.(requestFailedResponse); err != nil || !failed {
				t.Fatalf("valid observation should reach the absent media session: %#v, %v", result, err)
			}
		})
	}
}
