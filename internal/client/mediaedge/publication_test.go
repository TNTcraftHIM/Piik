package mediaedge

import (
	"errors"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/TNTcraftHIM/Screener/internal/media/forwarding"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

func TestPublicationOwnsOneReservationAndSourceLifetime(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	source, err := engine.NewSource("vp8", 3, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	for index := 0; index < 2; index++ {
		if err = source.SetFormat(index, 320, 180); err != nil {
			t.Fatal(err)
		}
	}
	if err = source.ConfigureOutputs([]uint32{90_000, 300_000}); err != nil {
		t.Fatal(err)
	}
	publication, err := engine.NewPublication(source, EdgeOptions{ConnectionID: "publication"})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := engine.NewPublication(source, EdgeOptions{ConnectionID: "publication"})
	if err != nil {
		t.Fatal(err)
	}
	if err = publication.transport.SetConnected(); err != nil {
		t.Fatal(err)
	}
	if err = candidate.transport.SetConnected(); err != nil {
		t.Fatal(err)
	}
	if len(source.media.GetDownTracks()) != 4 {
		t.Fatalf("candidate overwrote current outputs: tracks=%d current=%s candidate=%s",
			len(source.media.GetDownTracks()), publication.transport.PC.ID(), candidate.transport.PC.ID())
	}
	if _, err = engine.NewPublication(source, EdgeOptions{ConnectionID: "third"}); err == nil {
		t.Fatal("third publication was admitted")
	}
	if source.reservations != 2 {
		t.Fatal("failed publication leaked its reservation")
	}
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "sibling"})
	if err != nil {
		t.Fatal(err)
	}
	defer edge.Close()
	if _, err = engine.NewEdge(source, EdgeOptions{ConnectionID: "overflow"}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatal("publication did not consume exactly one outbound copy")
	}
	if err = candidate.Close(); err != nil {
		t.Fatal(err)
	}
	if source.reservations != 1 || len(source.publications) != 1 || publication.signaling.connection.ConnectionState() == webrtc.PeerConnectionStateClosed {
		t.Fatal("candidate rollback retired the current publication")
	}
	replacement, err := engine.NewPublication(source, EdgeOptions{ConnectionID: "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	if err = source.DisableLayer(0); err != nil {
		t.Fatal(err)
	}
	if _, err = engine.NewPublication(source, EdgeOptions{ConnectionID: "failed-output"}); err == nil {
		t.Fatal("failed output was admitted into publication metadata")
	}
	if source.reservations != 0 || len(source.publications) != 0 {
		t.Fatal("failed publication demand retained a reservation")
	}
	if err = source.ConfigureOutputs([]uint32{90_000, 300_000}); err != nil {
		t.Fatal(err)
	}
	replacement, err = engine.NewPublication(source, EdgeOptions{ConnectionID: "restored-output"})
	if err != nil {
		t.Fatalf("validated replacement did not restore publication admission: %v", err)
	}
	if err = source.Close(); err != nil {
		t.Fatal(err)
	}
	if replacement.signaling.connection.ConnectionState() != webrtc.PeerConnectionStateClosed || len(engine.publications) != 0 || source.reservations != 0 {
		t.Fatal("source retirement did not release the publication")
	}
}

func TestPublicationQualityUsesHighestSentLayerCadence(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 1, 2, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 320, 180))
	check(source.SetFormat(1, 640, 360))
	check(source.ConfigureOutputs([]uint32{90_000, 300_000}))
	publication, err := engine.NewPublication(source, EdgeOptions{ConnectionID: "publication_quality"})
	check(err)
	mediaEngine := &webrtc.MediaEngine{}
	check(mediaEngine.RegisterDefaultCodecs())
	for _, uri := range []string{"urn:ietf:params:rtp-hdrext:sdes:mid", "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"} {
		check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: uri}, webrtc.RTPCodecTypeVideo))
	}
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(mediaEngine, registry))
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, readErr := track.ReadRTP(); readErr != nil {
				return
			}
		}
	})
	connectEdgeToReceiver(t, &publication.signaling, receiver)
	assigned, err := forwarding.NewEncodedSource(forwarding.SourceOptions{
		ID: string(source.media.TrackID()), StreamID: source.media.StreamID(), Codec: source.media.Codec(), MaxPackets: encoded.MaxPacketWindow,
		Formats: []forwarding.LayerFormat{{Width: 8, Height: 8, Bitrate: 45_000}, {Width: 8, Height: 8, Bitrate: 150_000}},
	})
	check(err)
	defer assigned.Close()
	check(assigned.BeginFrame(0, time.Now()))
	for layer := range 2 {
		check(assigned.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, Duration: time.Second / 30, Recovery: true}))
	}
	check(publication.transport.ReplaceSource(assigned.Source))
	metadata := publication.Media()
	if len(metadata.Layers) != 2 || metadata.Layers[0].Width != 8 || metadata.Layers[0].Height != 8 ||
		metadata.Layers[0].Bitrate != 45_000 || metadata.Layers[1].Bitrate != 150_000 {
		t.Fatalf("publication descriptor ignored assigned source: %+v", metadata)
	}
	now := time.Now()
	if _, ok := publication.QualitySample(now); ok {
		t.Fatal("first sample invented a window")
	}
	for frame := range 60 {
		pts := time.Duration(frame+1) * time.Second / 30
		check(assigned.BeginFrame(pts, time.Now()))
		check(assigned.WriteFrame(0, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
		if frame%2 == 0 {
			check(assigned.WriteFrame(1, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 15, Recovery: true}))
		}
		time.Sleep(time.Second / 30)
	}
	sample, ok := publication.QualitySample(now.Add(2 * time.Second))
	if !ok || sample.RID != "h" || sample.ActiveVideoEncodingCount != 2 || sample.Width != 8 || sample.Height != 8 {
		t.Fatalf("actual publication dimensions or active outputs missing: %+v counters=%+v", sample, publication.transport.Counters())
	}
	if sample.IntervalFramesSent == 0 || sample.IntervalFramesSent != publication.qualityCounters.Frames[1] ||
		sample.FramesPerSecond != float64(publication.qualityCounters.Frames[1])/2 {
		t.Fatalf("publication summed layer cadence instead of highest sent output: %+v", sample)
	}
	if sample.BitrateKbps != float64(publication.qualityCounters.VideoBytes*8)/2/1000 {
		t.Fatal("publication did not aggregate actual written layer bytes")
	}
}
