package nativeviewer

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/pion/webrtc/v4"
)

func TestOfferReuseKeepsSourceAndChildOwnership(t *testing.T) {
	offer := func(audio bool) webrtc.SessionDescription {
		t.Helper()
		peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = peer.Close() })
		if _, err = peer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
			t.Fatal(err)
		}
		if audio {
			if _, err = peer.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
				webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
				t.Fatal(err)
			}
		}
		value, err := peer.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, reuse := range []bool{false, true} {
		session, err := Start(t.Context(), Options{ShareID: "viewer-session", EdgeCapacity: 2})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		for _, audio := range []bool{false, true, false} {
			input := offer(audio)
			result, err := session.AcceptOffer("upstream", input, nil, reuse, false)
			if err != nil || result.Reused || result.Audio != audio {
				t.Fatalf("new media shape: %+v, %v", result, err)
			}
			if session.edge("local-playback") != nil {
				t.Fatal("incompatible source retained its old edge")
			}
			receiver := session.receiver("upstream")
			if _, err = session.PrepareLocalEdge("upstream", "local-playback", "local_offer_1", false); err != nil {
				t.Fatal(err)
			}
			child := session.edge("local-playback")
			result, err = session.AcceptOffer("upstream", input, nil, reuse, false)
			if err != nil || result.Reused != reuse {
				t.Fatalf("repeat offer: %+v, %v", result, err)
			}
			if reuse {
				if session.receiver("upstream") != receiver || session.edge("local-playback") != child {
					t.Fatal("compatible offer retired the existing source or child")
				}
			} else if session.receiver("upstream") == receiver || session.edge("local-playback") != nil {
				t.Fatal("legacy request did not retain its replacement behavior")
			}
		}
	}
}

func TestViewerProfileHasNoImplicitCaptureDefault(t *testing.T) {
	session := &Session{}
	if session.profile != nil || session.UpdateProfile(nativecapture.VideoProfile{}) == nil {
		t.Fatal("receive-only Viewer acquired an implicit or invalid profile")
	}
	profile := nativecapture.VideoProfile{
		Width: 1920, Height: 1080, Framerate: 30, Bitrate: 5_000_000, Preference: "balanced",
	}
	if err := session.UpdateProfile(profile); err != nil || session.profile == nil || *session.profile != profile {
		t.Fatalf("explicit Viewer profile = %v, %v", session.profile, err)
	}
	previous := session.profile
	if err := session.UpdateProfile(profile); err != nil || session.profile != previous {
		t.Fatal("unchanged ceiling created another profile update")
	}
	session.closed = true
	if session.UpdateProfile(profile) == nil {
		t.Fatal("closed Viewer accepted a profile")
	}
}

func TestReceiverCapacityPreservesCurrentAndPreparedSources(t *testing.T) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	if _, err = peer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	session, err := Start(t.Context(), Options{ShareID: "viewer-session", EdgeCapacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	for _, id := range []string{"active", "candidate"} {
		if _, err = session.AcceptOffer(id, offer, nil, false, false); err != nil {
			t.Fatal(err)
		}
	}
	active, candidate := session.receiver("active"), session.receiver("candidate")
	if _, err = session.AcceptOffer("excess", offer, nil, false, false); err == nil {
		t.Fatal("a third receiver bypassed the active/candidate bound")
	}
	if session.receiver("active") != active || session.receiver("candidate") != candidate || session.receiver("excess") != nil {
		t.Fatal("capacity rejection changed an existing receiver")
	}
	if result, err := session.AcceptOffer("active", offer, nil, true, false); err != nil || !result.Reused {
		t.Fatalf("existing receiver could not renegotiate at capacity: %v", err)
	}
	if _, err = session.PrepareLocalEdge("active", "local-preview", "preview-offer", false); err != nil {
		t.Fatalf("capacity rejection stopped local playback preparation: %v", err)
	}
	if _, err = session.AcceptOffer("candidate", offer, nil, false, false); err != nil {
		t.Fatalf("existing receiver could not be replaced at capacity: %v", err)
	}
	if session.receiver("active") != active || session.receiver("candidate") == candidate || session.edge("local-preview") == nil {
		t.Fatal("receiver replacement changed the active source or its playback")
	}
	session.CloseReceiver("candidate")
	if _, err = session.AcceptOffer("replacement", offer, nil, false, false); err != nil {
		t.Fatalf("retired receiver did not release its slot: %v", err)
	}
}
