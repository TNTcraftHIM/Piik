package remote

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestSelectedRouteLeavesARemoteRelayCandidateUnknown(t *testing.T) {
	report := webrtc.StatsReport{
		"local": webrtc.ICECandidateStats{
			ID:            "local",
			Protocol:      "udp",
			CandidateType: webrtc.ICECandidateTypeHost,
		},
		"remote": webrtc.ICECandidateStats{
			ID:            "remote",
			Protocol:      "udp",
			CandidateType: webrtc.ICECandidateTypeRelay,
		},
	}
	pair := webrtc.ICECandidatePairStats{LocalCandidateID: "local", RemoteCandidateID: "remote"}
	if route := selectedRoute(report, pair); route != "unknown" {
		t.Fatalf("selected route = %q, want unknown", route)
	}
}

func TestSelectedRouteLeavesALocalRelayCandidateUnknown(t *testing.T) {
	report := webrtc.StatsReport{
		"local": webrtc.ICECandidateStats{
			ID: "local", Protocol: "udp", CandidateType: webrtc.ICECandidateTypeRelay,
		},
		"remote": webrtc.ICECandidateStats{
			ID: "remote", Protocol: "udp", CandidateType: webrtc.ICECandidateTypeHost,
		},
	}
	pair := webrtc.ICECandidatePairStats{LocalCandidateID: "local", RemoteCandidateID: "remote"}
	if route := selectedRoute(report, pair); route != "unknown" {
		t.Fatalf("selected route = %q, want unknown", route)
	}
}

func TestSelectedRouteRequiresBothCandidatesBeforeClaimingDirect(t *testing.T) {
	report := webrtc.StatsReport{
		"local": webrtc.ICECandidateStats{
			ID:            "local",
			Protocol:      "udp",
			CandidateType: webrtc.ICECandidateTypeHost,
		},
	}
	pair := webrtc.ICECandidatePairStats{LocalCandidateID: "local", RemoteCandidateID: "missing"}
	if route := selectedRoute(report, pair); route != "unknown" {
		t.Fatalf("selected route = %q, want unknown", route)
	}
}

func TestPeerAnswerFailureIsSanitized(t *testing.T) {
	connection, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	viewer := &peer{connection: connection, connectionID: "connection-1"}
	err = viewer.acceptSignal(inboundSignalPayload{
		Kind: "description", ConnectionID: "connection-1",
		Description: &sessionDescription{Type: "answer", SDP: "private-sdp-marker"},
	})
	if err == nil || err.Error() != "apply viewer answer failed" {
		t.Fatalf("answer error = %q", err)
	}
}
