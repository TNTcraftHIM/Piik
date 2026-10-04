package mediaedge

import (
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// The current and candidate routes can have the same Native parent. Both Apps
// stay alive during preparation and rollback; replacing either Engine here
// would hide collisions in their shared UDP sockets.
func TestNativeReceiverOverlapKeepsCurrentMedia(t *testing.T) {
	for _, outcome := range []string{"rollback", "commit"} {
		t.Run(outcome, func(t *testing.T) {
			host, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = host.Close() })
			viewer, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = viewer.Close() })
			source, err := host.NewSource("vp8", 2, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })

			connect := func(id string) (*Edge, *Receiver, <-chan *rtp.Packet) {
				t.Helper()
				edge, err := host.NewEdge(source, EdgeOptions{ConnectionID: id})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = edge.Close() })
				gathered := webrtc.GatheringCompletePromise(edge.connection)
				if _, err = edge.CreateOffer(); err != nil {
					t.Fatal(err)
				}
				waitSignal(t, gathered, "Native offer")
				receiver, _, err := viewer.NewReceiver(ReceiverOptions{
					Offer: *edge.connection.LocalDescription(), EdgeCapacity: 1,
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = receiver.Close() })
				waitSignal(t, webrtc.GatheringCompletePromise(receiver.connection), "Native answer")
				if err = edge.SetAnswer(*receiver.connection.LocalDescription()); err != nil {
					t.Fatal(err)
				}
				waitConnected(t, edge.connection, id)
				_, playback, _, err := connectedReceiverForSources(t, viewer, receiver.Source(), nil, id+"-playback")
				if err != nil {
					t.Fatal(err)
				}
				return edge, receiver, playback
			}
			currentEdge, current, currentPackets := connect("current")
			if err = writeSourceFrame(source, sfu.VP8KeyFrame8x8, time.Second, time.Second/30); err != nil {
				t.Fatal(err)
			}
			_ = waitPacket(t, currentPackets)
			candidateEdge, candidate, candidatePackets := connect("candidate")
			if err = writeSourceFrame(source, sfu.VP8KeyFrame8x8, 2*time.Second, time.Second/30); err != nil {
				t.Fatal(err)
			}
			_ = waitPacket(t, currentPackets)
			_ = waitPacket(t, candidatePackets)
			retiredEdge, retired, surviving, survivingPackets := candidateEdge, candidate, current, currentPackets
			if outcome == "commit" {
				retiredEdge, retired, surviving, survivingPackets = currentEdge, current, candidate, candidatePackets
			}
			_ = retired.Close()
			_ = retiredEdge.Close()
			if err = writeSourceFrame(source, sfu.VP8KeyFrame8x8, 3*time.Second, time.Second/30); err != nil {
				t.Fatal(err)
			}
			_ = waitPacket(t, survivingPackets)
			if !surviving.active() {
				t.Fatal("retiring an overlapping route closed the surviving receiver")
			}
		})
	}
}
