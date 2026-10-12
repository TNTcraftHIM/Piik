package nativecontrol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

func TestPunchPreparationPreservesMediaRole(t *testing.T) {
	for _, sourceID := range []string{"", "retired_receiver"} {
		t.Run("sender/"+sourceID, func(t *testing.T) {
			session := New("", nativecapture.Capabilities{}, false)
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
		session := New("", nativecapture.Capabilities{}, false)
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
			session := New("", nativecapture.Capabilities{}, false)
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
