package mediaedge

import (
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func descriptionUfrag(t *testing.T, description webrtc.SessionDescription) string {
	t.Helper()
	parsed, err := description.Unmarshal()
	if err != nil {
		t.Fatal(err)
	}
	for _, media := range parsed.MediaDescriptions {
		if value, ok := media.Attribute("ice-ufrag"); ok {
			return value
		}
	}
	t.Fatal("description has no ICE username fragment")
	return ""
}

func TestPionQueuedCandidatesKeepTheirGatheringGeneration(t *testing.T) {
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	connection, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if _, err = connection.CreateDataChannel("gathering", nil); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	var once sync.Once
	connection.OnICECandidate(func(*webrtc.ICECandidate) {
		once.Do(func() { close(entered); <-release })
	})
	offer, err := connection.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = connection.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	previous := descriptionUfrag(t, offer)
	waitSignal(t, entered, "held Pion candidate callback")
	remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = remote.Close() })
	if err = remote.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := remote.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = remote.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	if err = connection.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	// Let the old generation queue its completion behind the held callback.
	time.Sleep(50 * time.Millisecond)
	next, err := connection.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	current := descriptionUfrag(t, next)
	engine, err := NewEngine(EngineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	emitted := make(chan *webrtc.ICECandidateInit, 32)
	gathering := newLocalCandidateGathering(testICESocket(t, engine), nil, nil, current,
		func(candidate *webrtc.ICECandidateInit) { emitted <- candidate })
	t.Cleanup(gathering.close)
	raw := make(chan *webrtc.ICECandidate, 32)
	connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		gathering.addPion(candidate)
		raw <- candidate
	})
	if err = connection.SetLocalDescription(next); err != nil {
		t.Fatal(err)
	}
	close(release)
	currentCandidates, completions := 0, 0
	deadline := time.After(time.Second)
	for completions < 2 {
		select {
		case candidate := <-raw:
			if candidate == nil {
				completions++
			} else if strings.Contains(candidate.ToJSON().Candidate, " ufrag "+current) {
				currentCandidates++
			}
		case <-deadline:
			t.Fatal("Pion did not drain both gathering generations")
		}
	}
	if current == previous || currentCandidates == 0 {
		t.Fatal("the callback queue did not exercise an ICE restart")
	}
	gotCandidates, gotEnd := 0, false
	for {
		select {
		case candidate := <-emitted:
			if candidate == nil {
				if gotCandidates == 0 || gotEnd {
					t.Fatal("old completion ended the current gathering")
				}
				gotEnd = true
			} else {
				if gotEnd || strings.Contains(candidate.Candidate, " ufrag "+previous) ||
					candidate.UsernameFragment == nil || *candidate.UsernameFragment != current {
					t.Fatal("queued old Pion candidate entered the current gathering")
				}
				gotCandidates++
			}
		default:
			if !gotEnd || gotCandidates != currentCandidates {
				t.Fatalf("current gathering lost candidates or completion: candidates=%d/%d, end=%v", gotCandidates, currentCandidates, gotEnd)
			}
			return
		}
	}
}

func TestNativeRemoteCandidatesRespectJSONGeneration(t *testing.T) {
	for _, receiverSide := range []bool{false, true} {
		name := "sender-queued-before-answer"
		if receiverSide {
			name = "receiver-after-ICE-restart"
		}
		t.Run(name, func(t *testing.T) {
			engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = engine.Close() })
			remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = remote.Close() })
			var connection *webrtc.PeerConnection
			var add func(*webrtc.ICECandidateInit) error
			var applyAnswer func()
			var previous, current string
			if receiverSide {
				if _, err = remote.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
					webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
					t.Fatal(err)
				}
				offer, err := remote.CreateOffer(nil)
				if err != nil {
					t.Fatal(err)
				}
				if err = remote.SetLocalDescription(offer); err != nil {
					t.Fatal(err)
				}
				receiver, answer, err := engine.NewReceiver(ReceiverOptions{Offer: offer, EdgeCapacity: 1})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = receiver.Close() })
				if err = remote.SetRemoteDescription(answer); err != nil {
					t.Fatal(err)
				}
				previous = descriptionUfrag(t, offer)
				offer, err = remote.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
				if err != nil {
					t.Fatal(err)
				}
				if err = remote.SetLocalDescription(offer); err != nil {
					t.Fatal(err)
				}
				if _, reused, err := receiver.Renegotiate(offer, nil); err != nil || !reused {
					t.Fatalf("receiver restart failed: reused=%v, error=%v", reused, err)
				}
				current = descriptionUfrag(t, offer)
				connection, add = receiver.connection, receiver.AddRemoteCandidate
			} else {
				source, err := engine.NewSource("vp8", 1, 1, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = source.Close() })
				edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "candidate-generation"})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = edge.Close() })
				offer, err := edge.CreateOffer()
				if err != nil {
					t.Fatal(err)
				}
				if err = remote.SetRemoteDescription(offer); err != nil {
					t.Fatal(err)
				}
				answer, err := remote.CreateAnswer(nil)
				if err != nil {
					t.Fatal(err)
				}
				current, previous = descriptionUfrag(t, answer), "retired_generation"
				connection, add = edge.connection, edge.AddRemoteCandidate
				applyAnswer = func() {
					if err := edge.SetAnswer(answer, ""); err != nil {
						t.Fatal(err)
					}
				}
			}
			if previous == current {
				t.Fatal("ICE restart retained its username fragment")
			}
			ports := []int{}
			for _, fragment := range []*string{&previous, &current, nil} {
				listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = listener.Close() })
				port := listener.LocalAddr().(*net.UDPAddr).Port
				ports = append(ports, port)
				// Standards-shaped JSON fragment, deliberately absent from the SDP line.
				if err := add(&webrtc.ICECandidateInit{UsernameFragment: fragment,
					Candidate: "candidate:probe 1 udp 2122260223 127.0.0.1 " + strconv.Itoa(port) + " typ host"}); err != nil {
					t.Fatal(err)
				}
			}
			if applyAnswer != nil {
				applyAnswer()
			}
			currentSeen, legacySeen := false, false
			until := time.Now().Add(250 * time.Millisecond)
			for time.Now().Before(until) {
				for _, stat := range connection.GetStats() {
					candidate, ok := stat.(webrtc.ICECandidateStats)
					if !ok || candidate.Type != webrtc.StatsTypeRemoteCandidate {
						continue
					}
					if int(candidate.Port) == ports[0] {
						t.Fatal("retired JSON username fragment entered the current ICE checklist")
					}
					currentSeen = currentSeen || int(candidate.Port) == ports[1]
					legacySeen = legacySeen || int(candidate.Port) == ports[2]
				}
				time.Sleep(time.Millisecond)
			}
			if !currentSeen || !legacySeen {
				t.Fatalf("positive controls not admitted: current=%v legacy=%v", currentSeen, legacySeen)
			}
		})
	}
}
