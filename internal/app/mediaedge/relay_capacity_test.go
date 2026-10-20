package mediaedge

import (
	"errors"
	"fmt"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

func TestVolunteerFanoutSharesBoundedOutputsAndReleasesPhysicalCapacity(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	capacity := PhysicalSourceCapacity(MaxRelayChildren)
	source, err := engine.newSource("vp8", capacity, 2, &RelayOptions{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	audio, err := engine.NewRelayedAudioSource(capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audio.Close() })
	if err := source.SetRelayProfile(nativecapture.VideoProfile{Width: 1280, Height: 720,
		Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}); err != nil {
		t.Fatal(err)
	}
	if len(source.outputBitrates) != 2+nativecapture.MaxOutputGroups {
		t.Fatalf("fanout allocated %d encoder outputs", len(source.outputBitrates))
	}
	var edges []*Edge
	for index := range capacity {
		edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: fmt.Sprintf("child-%d", index), Audio: audio})
		if err != nil {
			t.Fatalf("physical child %d: %v", index, err)
		}
		edges = append(edges, edge)
	}
	if _, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "overflow", Audio: audio}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("overflow admission = %v", err)
	}
	if err := edges[0].Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "replacement", Audio: audio}); err != nil {
		t.Fatalf("retired child did not release both media capacities: %v", err)
	}
	if _, err := engine.NewSource("vp8", capacity+1, 2, nil); err == nil {
		t.Fatal("unbounded native source accepted")
	}
}
