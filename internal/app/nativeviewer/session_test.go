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
			result, err := session.AcceptOffer("upstream", input, nil, reuse)
			if err != nil || result.Reused || result.Audio != audio {
				t.Fatalf("new media shape: %+v, %v", result, err)
			}
			if session.edge("local-playback") != nil {
				t.Fatal("incompatible source retained its old edge")
			}
			receiver := session.receiver("upstream")
			if _, err = session.PrepareLocalEdge("upstream", "local-playback"); err != nil {
				t.Fatal(err)
			}
			child := session.edge("local-playback")
			result, err = session.AcceptOffer("upstream", input, nil, reuse)
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
