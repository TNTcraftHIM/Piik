package remote

import (
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/media"
	"github.com/pion/webrtc/v4"
)

func TestH264PeerAPIRegistersFixtureProfileAndRTX(t *testing.T) {
	api, preferences, err := newPeerAPI(media.CodecH264)
	if err != nil {
		t.Fatal(err)
	}
	if api == nil || len(preferences) != 2 {
		t.Fatalf("H.264 API/preferences = %v/%d", api != nil, len(preferences))
	}
	if preferences[0].MimeType != webrtc.MimeTypeH264 ||
		preferences[0].SDPFmtpLine != media.H264SDPFmtpLine ||
		preferences[1].MimeType != webrtc.MimeTypeRTX || preferences[1].SDPFmtpLine != "apt=114" {
		t.Fatalf("H.264 preferences = %+v", preferences)
	}
	if defaultAPI, defaultPreferences, err := newPeerAPI(media.CodecVP8); err != nil || defaultAPI != nil || defaultPreferences != nil {
		t.Fatalf("VP8 unexpectedly changed API boundary: %v/%v/%v", defaultAPI, defaultPreferences, err)
	}
}

func TestH264PeerAPIOffersFixtureProfileWhenTrackIsBound(t *testing.T) {
	api, preferences, err := newPeerAPI(media.CodecH264)
	if err != nil {
		t.Fatal(err)
	}
	fanout, err := media.NewFanoutWithCodec(media.CodecH264, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer fanout.Close()
	connection, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err = connection.AddTrack(fanout.Track()); err != nil {
		t.Fatal(err)
	}
	if err = connection.GetTransceivers()[0].SetCodecPreferences(preferences); err != nil {
		t.Fatal(err)
	}
	offer, err := connection.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !containsAll(offer.SDP, []string{"H264/90000", "profile-level-id=42c01f", "packetization-mode=1"}) {
		t.Fatalf("H.264 offer omitted fixture profile: %s", offer.SDP)
	}
}

func containsAll(value string, needles []string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}
