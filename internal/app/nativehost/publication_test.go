package nativehost

import (
	"context"
	"testing"
	"time"

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
	events := make(chan Event, 64)
	session := &Session{shareID: "share_12345678", engine: engine, source: source, ctx: t.Context(), events: func(ctx context.Context, event Event) {
		select {
		case events <- event:
		case <-ctx.Done():
		}
	}}
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
	key := publicationKey{"generation_12345678", "connection_12345678"}
	old, _ := session.Publication(key.generation, key.connectionID)
	if err = old.Close(); err != nil || !session.ownsPublication(key, old) {
		t.Fatal("current transport failure must still reach its owner", err)
	}
	var closedEvent Event
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for closedEvent.Current == nil {
		select {
		case event := <-events:
			if event.Type == "publication-state" && event.State == "closed" &&
				event.PublicationGeneration == key.generation && event.ConnectionID == key.connectionID {
				if event.Current == nil || !event.Current() {
					t.Fatal("current transport failure lost its delivery authority")
				}
				closedEvent = event
			}
		case <-deadline.C:
			t.Fatal("publication did not emit its terminal state")
		}
	}
	session.ClosePublication("generation_12345678", "connection_12345678")
	if _, err = session.Publication("generation_12345678", "connection_12345678"); err == nil {
		t.Fatal("closed publication remained accessible")
	}
	if _, _, err = session.PreparePublication(key.generation, key.connectionID, nil); err != nil {
		t.Fatal(err)
	}
	defer session.ClosePublication(key.generation, key.connectionID)
	replacement, _ := session.Publication(key.generation, key.connectionID)
	if closedEvent.Current() || session.ownsPublication(key, old) || !session.ownsPublication(key, replacement) {
		t.Fatal("same-key replacement accepted the retired publication")
	}
}
