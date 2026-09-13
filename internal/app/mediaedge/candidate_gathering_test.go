package mediaedge

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

func localSurveyServer(t *testing.T) string {
	t.Helper()
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server, err := turn.NewServer(turn.ServerConfig{
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: listener}},
		LoggerFactory:     diagnostics.PionLoggerFactory(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return "stun:" + listener.LocalAddr().String()
}

func TestCandidatesTrickleBeforeGatewayMappingCompletes(t *testing.T) {
	for _, closeFirst := range []bool{false, true} {
		name := "mapping-finishes"
		if closeFirst {
			name = "connection-retires"
		}
		t.Run(name, func(t *testing.T) {
			engine, err := NewEngine(EngineOptions{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = engine.Close() })
			mapping := make(chan int, 1)
			t.Cleanup(func() { close(mapping) })
			started := make(chan struct{})
			candidates := make(chan *webrtc.ICECandidateInit, 8)
			gathering := newLocalCandidateGathering(engine,
				[]webrtc.ICEServer{{URLs: []string{localSurveyServer(t)}}},
				func() int { close(started); return <-mapping },
				func(candidate *webrtc.ICECandidateInit) { candidates <- candidate },
			)
			t.Cleanup(gathering.close)
			gathering.start()
			waitSignal(t, started, "mapping start")
			gathering.addPion(&webrtc.ICECandidate{
				Foundation: "host", Component: 1, Protocol: webrtc.ICEProtocolUDP,
				Address: "127.0.0.1", Port: uint16(engine.localPort), Typ: webrtc.ICECandidateTypeHost,
			})
			gathering.addPion(nil)
			for received := 0; received < 2; received++ {
				select {
				case candidate := <-candidates:
					if candidate == nil || (!strings.Contains(candidate.Candidate, "candidate:host ") &&
						!strings.Contains(candidate.Candidate, "candidate:ns1 ")) {
						t.Fatalf("expected ordinary candidate before mapping: %+v", candidate)
					}
				case <-time.After(time.Second):
					t.Fatal("ordinary ICE waited for the gateway mapping")
				}
			}
			select {
			case candidate := <-candidates:
				t.Fatalf("gathering ended before its mapping owner finished: %+v", candidate)
			default:
			}
			if closeFirst {
				gathering.close()
			}
			mapping <- engine.localPort%65535 + 1
			if closeFirst {
				select {
				case candidate := <-candidates:
					t.Fatalf("retired generation emitted a late candidate: %+v", candidate)
				case <-time.After(50 * time.Millisecond):
				}
				return
			}
			for _, want := range []string{"candidate:mp1 ", "end"} {
				select {
				case candidate := <-candidates:
					if want == "end" && candidate != nil || want != "end" &&
						(candidate == nil || !strings.Contains(candidate.Candidate, want)) {
						t.Fatalf("expected %s after mapping: %+v", want, candidate)
					}
				case <-time.After(time.Second):
					t.Fatalf("missing %s after mapping", want)
				}
			}
			gathering.addPion(nil)
			select {
			case <-candidates:
				t.Fatal("duplicate end-of-candidates")
			default:
			}
		})
	}
}

func TestSurveyHealthySTUNDoesNotWaitForSlowDNS(t *testing.T) {
	engine, err := NewEngine(EngineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	original := net.DefaultResolver
	t.Cleanup(func() { net.DefaultResolver = original })
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	observations := make(chan mappedAddress, 1)
	done := make(chan struct{})
	servers := []webrtc.ICEServer{{URLs: []string{"stun:unanswered.invalid.:3478", localSurveyServer(t)}}}
	started := time.Now()
	go func() {
		defer close(done)
		engine.surveySTUN(t.Context(), servers, func(mapped mappedAddress) { observations <- mapped })
	}()
	select {
	case mapped := <-observations:
		if mapped.port != engine.localPort {
			t.Fatal("STUN did not use the shared media socket")
		}
	case <-time.After(time.Second):
		t.Fatal("healthy STUN waited for the broken DNS target")
	}
	select {
	case <-done:
		if elapsed := time.Since(started); elapsed > stunSurveyTimeout+time.Second {
			t.Fatalf("DNS exceeded the survey bound: %v", elapsed)
		}
	case <-time.After(stunSurveyTimeout + time.Second):
		t.Fatal("DNS resolution ignored the survey deadline")
	}
}

func TestSurveyReturnsWhenEveryDestinationAlreadyFailed(t *testing.T) {
	probe, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6loopback})
	if err != nil {
		t.Skipf("IPv6 loopback UDP is unavailable: %v", err)
	}
	_ = probe.Close()
	// A concrete IPv6 loopback socket cannot send an IPv4 Binding request.
	// This is an immediate transport error, not a missing STUN response.
	engine, err := NewEngine(EngineOptions{BindAddress: "[::1]:0"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	started := time.Now()
	engine.surveySTUN(t.Context(), []webrtc.ICEServer{{URLs: []string{"stun:127.0.0.1:9"}}},
		func(mappedAddress) { t.Error("failed transport emitted a candidate") })
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("completed failure retained its survey timer: %v", elapsed)
	}
}
