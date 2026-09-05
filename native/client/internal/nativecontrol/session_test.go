package nativecontrol

import (
	"testing"

	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
)

func TestSTUNURLsUseTheCurrentBoundedWire(t *testing.T) {
	servers, err := pionICEServers([]iceServer{{URLs: []string{
		"stun:example.test:3478",
		"stun:example.test:3479",
	}}})
	if err != nil || len(servers) != 1 || len(servers[0].URLs) != 2 {
		t.Fatalf("servers = %+v, %v", servers, err)
	}
	for _, value := range []string{
		"turn:example.com:3478",
		"stun:user@example.com:3478",
		"stun:example.com:0",
		"stun:example.com/path",
	} {
		if validSTUNURL(value) {
			t.Fatalf("invalid STUN URL accepted: %s", value)
		}
	}
}

func TestControlMessagesRejectUnknownFieldsAndStaleVersions(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	for _, payload := range []string{
		`{"version":8,"id":"request_sources","type":"list-sources","extra":true}`,
		`{"version":4,"id":"request_sources","type":"list-sources"}`,
		`{"version":5,"id":"short","type":"stop-share","shareId":"share_123456"}`,
	} {
		if _, err := session.Handle(t.Context(), []byte(payload)); err == nil {
			t.Fatalf("invalid control message accepted: %s", payload)
		}
	}
}

func TestResponseKeepsTheRequestIdentity(t *testing.T) {
	value := response(requestEnvelope{
		Version: loopback.ProtocolVersion,
		ID:      "request_123456",
		Type:    "stop-share",
	}, "share-stopped")
	if value.Version != loopback.ProtocolVersion || value.ID != "request_123456" ||
		value.Type != "share-stopped" {
		t.Fatalf("response = %+v", value)
	}
}

func TestPrepareLocalEdgeOwnsOneStrictRequestShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":8,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567"}`
	if _, err := session.Handle(t.Context(), []byte(valid)); err == nil || err.Error() != "native media source does not exist" {
		t.Fatalf("valid local-edge request stopped at wrong boundary: %v", err)
	}
	invalid := `{"version":8,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567","iceServers":[]}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil || err.Error() != "native prepare-local-edge request is invalid" {
		t.Fatalf("extended local-edge request was accepted: %v", err)
	}
}

func TestPreviewFailureReturnsAnAdvisoryResponse(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":8,"id":"request_preview","type":"source-preview","source":{"kind":"display","sourceId":"65537","title":"Display 1"}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	response, ok := value.(sourcePreviewResponse)
	if !ok || response.Data != "" || response.SourceKey != "display:65537" {
		t.Fatalf("preview response = %#v", value)
	}
}

func TestQualitySettingsMapOnceIntoNativeMedia(t *testing.T) {
	settings := qualitySettings{
		Resolution: "1440p", MaxFramerate: 60, MaxBitrate: 12_000_000,
		DegradationPreference: "maintain-framerate",
		ScreenAudioQuality:    "very-high",
	}
	profile := nativeQualityProfile(settings)
	if !validQualitySettings(settings) || profile.Video.Width != 2560 ||
		profile.Video.Height != 1440 || profile.Video.Framerate != 60 ||
		profile.Video.Bitrate != 12_000_000 ||
		profile.Video.Preference != "maintain-framerate" ||
		profile.AudioBitrate != 192_000 {
		t.Fatalf("native profile = %+v", profile)
	}
	settings.Resolution = "2160p"
	if validQualitySettings(settings) {
		t.Fatal("unsupported resolution was accepted")
	}
}

func TestUpdateShareRequiresTheCurrentStrictProfile(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":8,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","screenAudioQuality":"music"}}`
	if _, err := session.Handle(t.Context(), []byte(valid)); err == nil ||
		err.Error() != "native share does not exist" {
		t.Fatalf("valid update stopped at wrong boundary: %v", err)
	}
	invalid := `{"version":8,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","screenAudioQuality":"music","extra":true}}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native update-share request is invalid" {
		t.Fatalf("extended update was accepted: %v", err)
	}
}

func TestReplaceShareSourceKeepsOneStrictTargetShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":8,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0}`
	if _, err := session.Handle(t.Context(), []byte(valid)); err == nil ||
		err.Error() != "native share does not exist" {
		t.Fatalf("valid source replacement stopped at wrong boundary: %v", err)
	}
	invalid := `{"version":8,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0,"extra":true}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native replace-share-source request is invalid" {
		t.Fatalf("extended source replacement was accepted: %v", err)
	}
}
