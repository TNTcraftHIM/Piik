package forwarding

import (
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	"github.com/pion/webrtc/v4"
)

// This fixture supplies allocation metadata, not simulated network evidence.
type allocationReceiver struct {
	*sfu.ReceiverBase
	rates      sfu.Bitrates
	available  []int32
	controlled bool
}

func (receiver *allocationReceiver) RateControlled(layer int32) bool {
	return receiver.controlled && layer == 0
}

func (receiver *allocationReceiver) GetLayeredBitrate() ([]int32, sfu.Bitrates) {
	return receiver.available, receiver.rates
}

type outputListener struct{}

func (*outputListener) OnBindAndConnected()                         {}
func (*outputListener) OnStatsUpdate(*livekit.AnalyticsStat)        {}
func (*outputListener) OnMaxSubscribedLayerChanged(int32)           {}
func (*outputListener) OnRttUpdate(uint32)                          {}
func (*outputListener) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*outputListener) OnDownTrackClose(bool)                       {}
func (*outputListener) OnStreamStarted(time.Duration)               {}

func TestOutputUsesLibraryAllocationAndExactLifetime(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, PayloadType: 96}
	log := logger.GetLogger()
	base := sfu.NewReceiverBase(sfu.ReceiverBaseParams{
		TrackID: "fixture", StreamID: "fixture", Kind: webrtc.RTPCodecTypeVideo,
		Codec: codec, Logger: log, StreamTrackerManagerConfig: sfu.DefaultStreamTrackerManagerConfig,
	}, &livekit.TrackInfo{Sid: "fixture", Type: livekit.TrackType_VIDEO,
		Source: livekit.TrackSource_SCREEN_SHARE, Layers: []*livekit.VideoLayer{
			{SpatialLayer: 0, Bitrate: 100_000}, {SpatialLayer: 1, Bitrate: 300_000},
			{SpatialLayer: 2, Bitrate: 900_000},
		}}, sfu.ReceiverCodecStateNormal)
	defer base.Close("test complete", true)
	receiver := &allocationReceiver{ReceiverBase: base}
	packetPacer := pacer.NewPassThrough(log, nil)
	defer packetPacer.Stop()
	track, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Receiver: receiver,
		BufferFactory: buffer.NewFactoryOfBufferFactory(64, 16).CreateBufferFactory(),
		SubID:         "child", StreamID: "fixture", MaxTrack: 64,
		Pacer: packetPacer, Logger: log, Listener: &outputListener{},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := NewOutput(track, 1_000_000)
	defer output.Close()
	output.SetMaxSpatialLayer(2)
	output.SetMaxTemporalLayer(0)
	output.UpTrackMaxPublishedLayerChange(2)
	output.UpTrackMaxTemporalLayerSeenChange(0)
	if state := output.State(); state.Target != -1 || state.Current != -1 {
		t.Fatalf("unmeasured source pretended to have a target: %+v", state)
	}
	receiver.available = []int32{0}
	output.SetBudget(0)
	if state := output.State(); !state.Paused || state.Prepare != -1 || state.VideoBudget != 0 {
		t.Fatalf("bootstrap ignored an exhausted video budget: %+v", state)
	}
	receiver.rates = sfu.Bitrates{{100_000}, {300_000}, {900_000}}
	receiver.available = []int32{0, 1, 2}
	siblingTrack, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Receiver: receiver,
		BufferFactory: buffer.NewFactoryOfBufferFactory(64, 16).CreateBufferFactory(),
		SubID:         "healthy", StreamID: "fixture", MaxTrack: 64,
		Pacer: packetPacer, Logger: log, Listener: &outputListener{},
	})
	if err != nil {
		t.Fatal(err)
	}
	sibling := NewOutput(siblingTrack, 1_000_000)
	defer sibling.Close()
	sibling.SetMaxTemporalLayer(0)
	sibling.SetMaxSpatialLayer(2)
	sibling.UpTrackMaxPublishedLayerChange(2)
	sibling.UpTrackMaxTemporalLayerSeenChange(0)
	for _, check := range []struct {
		budget int64
		layer  int32
	}{{1_000_000, 2}, {200_000, 0}, {0, -1}, {400_000, 1}, {1_000_000, 2}} {
		output.SetBudget(check.budget)
		state := output.State()
		if state.Target != check.layer || state.Paused != (check.layer == -1) || state.Current != -1 || state.VideoBudget != check.budget {
			t.Fatalf("budget %d: %+v", check.budget, state)
		}
	}
	// A budget below every nominal output still reaches the lowest codec, while
	// only actual reduced media may make the library resume its network target.
	output.SetBudget(60_000)
	if state := output.State(); !state.Paused || state.Target != -1 || state.Prepare != 0 || state.VideoBudget != 60_000 {
		t.Fatalf("below-lowest budget cannot request codec adaptation: %+v", state)
	}
	receiver.controlled = true
	output.Reconcile()
	if state := output.State(); state.Paused || state.Target != 0 {
		t.Fatalf("live lowest codec could not continue bitrate adaptation: %+v", state)
	}
	output.SetBudget(0)
	if state := output.State(); !state.Paused {
		t.Fatalf("codec control overrode exhausted connection budget: %+v", state)
	}
	receiver.available = []int32{1, 2}
	receiver.rates[0][0] = 0
	output.SetBudget(60_000)
	if state := output.State(); !state.Paused {
		t.Fatalf("codec control selected an unavailable lowest layer: %+v", state)
	}
	receiver.available = []int32{0, 1, 2}
	receiver.controlled = false
	receiver.rates[0][0] = 50_000
	output.Reconcile()
	if state := output.State(); state.Paused || state.Target != 0 || state.VideoBudget != 60_000 {
		t.Fatalf("real reduced output did not resume library allocation: %+v", state)
	}
	sibling.Reconcile()
	if state := sibling.State(); state.Paused || state.Target != 2 || state.VideoBudget != 1_000_000 || receiver.rates[2][0] != 900_000 {
		t.Fatalf("weak-child adaptation changed the shared high output: %+v", state)
	}
	receiver.rates[0][0] = 100_000
	// A stopped upper output has no actual bitrate. Admission may prepare it,
	// but the library must not select it until it is genuinely available again.
	receiver.rates = sfu.Bitrates{{100_000}}
	receiver.available = []int32{0}
	output.SetBudget(1_000_000)
	if state := output.State(); state.Prepare != 2 || state.Target != 0 {
		t.Fatalf("stopped output preparation changed real availability: %+v", state)
	}
	output.SetBudget(200_000)
	if state := output.State(); state.Prepare != 0 || state.Target != 0 {
		t.Fatalf("low budget prepared an unaffordable upper output: %+v", state)
	}
	output.SetMaxSpatialLayer(1)
	output.SetBudget(1_000_000)
	if state := output.State(); state.Prepare != 1 {
		t.Fatalf("preparation exceeded child maximum: %+v", state)
	}
	output.SetMaxSpatialLayer(2)
	output.current = 2 // Allocation-only fixture; the real RTP gate verifies emitted frames.
	before := output.State()
	output.BeginFrame()
	after := output.State()
	if after.Current != -1 || after.Target != before.Target || after.Requested != before.Requested {
		t.Fatalf("controlled frame fence replaced its allocation: before=%+v after=%+v", before, after)
	}
	output.Resync()
	if state := output.State(); state.Target != -1 || state.Current != -1 {
		t.Fatalf("source resync retained old output state: %+v", state)
	}
	output.SetBudget(1_000_000)
	output.ReceiverRestart(receiver)
	if state := output.State(); state.Current != -1 {
		t.Fatalf("receiver restart retained old output state: %+v", state)
	}
	output.Close()
	output.SetBudget(1_000_000)
	if state := output.State(); state != (Snapshot{Prepare: -1, Target: -1, Requested: -1, Current: -1, Paused: true}) {
		t.Fatalf("closed output revived: %+v", state)
	}
}
