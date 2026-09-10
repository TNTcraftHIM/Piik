package mediaedge

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestLocalMediaCandidateCountsExcludePrivateFields(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(previous)
	logLocalMediaCandidateCounts(webrtc.StatsReport{
		"private-local": webrtc.ICECandidateStats{
			ID: "private-local", Type: webrtc.StatsTypeLocalCandidate,
			CandidateType: webrtc.ICECandidateTypeHost, Protocol: "udp",
			IP: "192.0.2.1", Port: 54321, URL: "private-url", TransportID: "private-transport",
		},
		"private-remote": webrtc.ICECandidateStats{
			ID: "private-remote", Type: webrtc.StatsTypeRemoteCandidate,
			CandidateType: webrtc.ICECandidateTypeHost, Protocol: "tcp",
		},
		"retired": webrtc.ICECandidateStats{
			Type: webrtc.StatsTypeLocalCandidate, CandidateType: webrtc.ICECandidateTypeHost,
			Protocol: "udp", Deleted: true,
		},
	})
	report := output.String()
	for _, private := range []string{"private-", "192.0.2.", "54321"} {
		if strings.Contains(report, private) {
			t.Fatalf("candidate summary exposed %q", private)
		}
	}
	entries := strings.Split(strings.TrimSpace(report), "\n")
	if len(entries) != 8 {
		t.Fatalf("got %d candidate count categories, want 8", len(entries))
	}
	for _, line := range entries {
		var entry struct {
			Direction string `json:"direction"`
			Type      string `json:"type"`
			UDP       int    `json:"udp"`
			TCP       int    `json:"tcp"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		udp, tcp := 0, 0
		if entry.Type == "host" {
			if entry.Direction == string(webrtc.StatsTypeLocalCandidate) {
				udp = 1
			} else {
				tcp = 1
			}
		}
		if entry.UDP != udp || entry.TCP != tcp {
			t.Fatalf("unexpected count: %+v", entry)
		}
	}
}
