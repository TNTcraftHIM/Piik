package nativehost

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
)

func TestPublicationGenerationFencesNativeControl(t *testing.T) {
	engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	source, err := engine.NewSource("vp8", 3, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.SetFormat(0, 320, 180); err != nil {
		t.Fatal(err)
	}
	if err = source.ConfigureOutputs([]uint32{300_000}); err != nil {
		t.Fatal(err)
	}
	session := &Session{shareID: "share_12345678", engine: engine, source: source, ctx: t.Context(), events: make(chan Event, 64)}
	_, media, err := session.PreparePublication("generation_12345678", "connection_12345678", nil)
	if err != nil || media.Codec != "vp8" || len(media.Layers) != 1 {
		t.Fatalf("publication did not reuse capture metadata: %+v %v", media, err)
	}
	if _, err = session.Publication("stale_generation", "connection_12345678"); err == nil {
		t.Fatal("stale generation accessed publication")
	}
	session.ClosePublication("stale_generation", "connection_12345678")
	if _, err = session.Publication("generation_12345678", "connection_12345678"); err != nil {
		t.Fatal("stale close retired current publication")
	}
	if _, _, err = session.PreparePublication("candidate_generation", "candidate_connection", nil); err != nil {
		t.Fatal("candidate preparation displaced the current publication", err)
	}
	if _, _, err = session.PreparePublication("third_generation", "third_connection", nil); err == nil {
		t.Fatal("third publication was admitted")
	}
	session.ClosePublication("candidate_generation", "candidate_connection")
	if _, err = session.Publication("generation_12345678", "connection_12345678"); err != nil {
		t.Fatal("candidate rollback retired current publication")
	}
	session.ClosePublication("generation_12345678", "connection_12345678")
	if _, err = session.Publication("generation_12345678", "connection_12345678"); err == nil {
		t.Fatal("closed publication remained accessible")
	}
}
