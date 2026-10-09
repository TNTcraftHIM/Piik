package forwarding

import (
	"bytes"
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/thirdparty/livekit/sendsidebwe"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func TestPublicationEmptyProbeCannotIncreaseCapacity(t *testing.T) {
	const target = int64(1_000_000)
	const audio = int64(64_000)
	log := logger.GetDiscardLogger()
	bandwidth := &publicationBWE{SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: log,
	})}
	bandwidth.target.Store(target)
	bandwidth.audio.Store(audio)
	queue := &publicationPacer{boundedPacer: newBoundedPacer(
		pacer.NewNoQueue(log, nil), log, 500,
	)}
	defer queue.Stop()
	info := ccutils.ProbeClusterInfo{Id: 1, CreatedAt: time.Now(), Goal: ccutils.ProbeClusterGoal{
		AvailableBandwidthBps: int(target), ExpectedUsageBps: int(target - audio),
		DesiredBps: int(target * 2), Duration: bandwidth.ProbeDuration(),
	}}
	info.Goal.DesiredBytes = int(float64(info.Goal.DesiredBps) * info.Goal.Duration.Seconds() / 8)
	bandwidth.ProbeClusterStarting(info)
	queue.StartProbeCluster(info)
	time.Sleep(info.Goal.Duration)
	info = queue.EndProbeCluster(info.Id)
	if info.Result.Bytes() != 0 || sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbeSignal.IsValid(info) {
		t.Fatal("fixture did not complete an empty invalid probe")
	}
	bandwidth.ProbeClusterDone(info)
	deadline := time.Now().Add(sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbePacketGroup.SettleWaitMax + time.Second)
	for {
		signal, capacity, done := bandwidth.ProbeClusterFinalize()
		if done {
			if signal != ccutils.ProbeSignalInconclusive || capacity > target-audio || bandwidth.target.Load() != target {
				t.Fatalf("empty probe raised publication capacity: signal=%v capacity=%d target=%d", signal, capacity, bandwidth.target.Load())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("empty probe did not finalize within the library settle bound")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPublicationProbeUsesAcknowledgedCapacity(t *testing.T) {
	for _, received := range []bool{true, false} {
		t.Run(map[bool]string{true: "received", false: "no-feedback"}[received], func(t *testing.T) {
			checkPublicationProbeCapacity(t, received)
		})
	}
}

func checkPublicationProbeCapacity(t *testing.T, received bool) {
	t.Helper()
	const target = int64(100_000)
	const audio = int64(64_000)
	bandwidth := &publicationBWE{SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: logger.GetDiscardLogger(),
	})}
	bandwidth.target.Store(target)
	bandwidth.audio.Store(audio)
	bandwidth.SetBWEListener(&publicationCapacityRecorder{})
	// A real non-congesting probe after reset still carries the library's
	// initial capacity. A successful 800 kbps probe cannot prove 100 Mbps.
	start := time.Now().Add(-time.Second)
	recorder := twcc.NewRecorder(42)
	// Establish transport history before the idle interval. The initial packet
	// has relative time zero, so include a subsequent packet as in a live stream.
	for _, age := range []time.Duration{6 * time.Second, 5 * time.Second} {
		previous := start.Add(-age).UnixMicro()
		sequence := bandwidth.RecordPacketSendAndGetSequenceNumber(previous, 200, false, ccutils.ProbeClusterIdInvalid, false)
		recorder.Record(42, sequence, previous+10_000)
	}
	for _, packet := range recorder.BuildFeedbackPacket() {
		bandwidth.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
	}
	bandwidth.Reset()
	info := ccutils.ProbeClusterInfo{Id: 1, CreatedAt: start, Goal: ccutils.ProbeClusterGoal{
		AvailableBandwidthBps: int(target), DesiredBps: 800_000,
		Duration: 200 * time.Millisecond, DesiredBytes: 20_000,
	}}
	bandwidth.ProbeClusterStarting(info)
	for index := range 100 {
		at := start.Add(time.Duration(index) * 2 * time.Millisecond).UnixMicro()
		sequence := bandwidth.RecordPacketSendAndGetSequenceNumber(at, 200, false, info.Id, true)
		recorder.Record(42, sequence, at+10_000)
	}
	info.Result = ccutils.ProbeClusterResult{StartTime: start.UnixNano(),
		EndTime: start.Add(info.Goal.Duration).UnixNano(), PacketsProbe: 100, BytesProbe: 20_000, IsCompleted: true}
	bandwidth.ProbeClusterDone(info)
	if received {
		for _, packet := range recorder.BuildFeedbackPacket() {
			bandwidth.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
		}
	}
	deadline := time.Now().Add(sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbePacketGroup.SettleWaitMax + time.Second)
	for {
		signal, capacity, done := bandwidth.ProbeClusterFinalize()
		if done {
			if received {
				// Allow the first-packet/time-window difference in the library's
				// acknowledged rate, but never its untouched 100 Mbps initial value.
				if signal != ccutils.ProbeSignalNotCongesting || capacity <= target-audio || capacity > 1_000_000-audio {
					t.Fatalf("probe promoted unmeasured capacity: signal=%v committed=%d sent=%.0f", signal, capacity+audio, info.Result.Bitrate())
				}
			} else if signal != ccutils.ProbeSignalInconclusive || capacity != target-audio {
				t.Fatalf("unacknowledged probe changed capacity: signal=%v committed=%d", signal, capacity+audio)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("probe did not finalize within the library settle bound")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type publicationCapacityRecorder struct{ capacity int64 }

func (recorder *publicationCapacityRecorder) OnCongestionStateChange(_, _ bwe.CongestionState, capacity int64) {
	recorder.capacity = capacity
}

func TestPublicationCongestionUsesCommittedCapacity(t *testing.T) {
	recorder := &publicationCapacityRecorder{}
	bandwidth := &publicationBWE{listener: recorder}
	bandwidth.target.Store(1_200_000)
	bandwidth.audio.Store(64_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateEarlyWarning, 100_000_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateEarlyWarning, bwe.CongestionStateCongested, 100_000_000)
	if bandwidth.target.Load() != 1_200_000 || recorder.capacity != 1_136_000 {
		t.Fatalf("publication promoted an unverified capacity: target=%d allocation=%d", bandwidth.target.Load(), recorder.capacity)
	}
	bandwidth.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateCongested, 500_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateNone, 800_000)
	if bandwidth.target.Load() != 500_000 || recorder.capacity != 436_000 {
		t.Fatalf("publication disagrees with its committed audio/video budget: target=%d allocation=%d", bandwidth.target.Load(), recorder.capacity)
	}
}

func TestPublicationSimulcastReuseAudioDemandAndClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: webrtc.TypeRTCPFBTransportCC}},
	}, PayloadType: 96}
	source, err := NewEncodedSource(SourceOptions{ID: "screen", StreamID: "publication-fixture", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 90_000}, {Width: 8, Height: 8, Bitrate: 300_000}}})
	check(err)
	defer source.Close()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2}, "audio", "publication-fixture")
	check(err)
	publication, err := NewPublication(TransportOptions{Source: source.Source, Settings: settings, ConnectionID: "publication", InitialBitrate: 1_000_000, Audio: audio})
	check(err)
	defer publication.Close()
	publication.SetAudioBitrate(64_000)
	if publication.VideoBudget() != 936_000 {
		t.Fatal("audio did not reserve the shared budget")
	}
	if len(publication.PC.GetSenders()) != 2 || len(publication.PC.GetSenders()[0].GetParameters().Encodings) != 2 {
		t.Fatal("publication must use one simulcast video sender and one audio sender")
	}
	mediaEngine := &webrtc.MediaEngine{}
	check(mediaEngine.RegisterDefaultCodecs())
	check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: publicationRIDExtension}, webrtc.RTPCodecTypeVideo))
	check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: "urn:ietf:params:rtp-hdrext:sdes:mid"}, webrtc.RTPCodecTypeVideo))
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(mediaEngine, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var received [3]atomic.Uint32
	var invalid atomic.Bool
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		index := 2
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			if track.RID() == "q" {
				index = 0
			} else if track.RID() == "h" {
				index = 1
			} else {
				invalid.Store(true)
				return
			}
		}
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			if len(packet.Payload) == 0 {
				continue
			}
			if index < 2 {
				var vp8 codecs.VP8Packet
				payload, decodeErr := vp8.Unmarshal(packet.Payload)
				if decodeErr != nil || !bytes.Equal(payload, sfu.VP8KeyFrame8x8) {
					invalid.Store(true)
					return
				}
			}
			received[index].Add(1)
		}
	})
	offer, err := publication.PC.CreateOffer(nil)
	check(err)
	gather := webrtc.GatheringCompletePromise(publication.PC)
	check(publication.PC.SetLocalDescription(offer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(receiver.SetRemoteDescription(*publication.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gather = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(publication.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for publication.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(publication.SetConnected())
	check(publication.SetConnected())
	if len(source.GetDownTracks()) != 2 {
		t.Fatal("publication did not attach exactly one output per encoding")
	}
	frame := 0
	write := func() {
		frame++
		pts := time.Duration(frame) * time.Second / 30
		check(source.BeginFrame(pts, time.Now()))
		for layer := 0; layer < 2; layer++ {
			check(source.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
		}
		check(audio.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}))
	}
	for received[0].Load() < 3 || received[1].Load() < 3 || received[2].Load() < 3 {
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatalf("publication RTP missing: low=%d high=%d audio=%d invalid=%t", received[0].Load(), received[1].Load(), received[2].Load(), invalid.Load())
		}
	}
	if invalid.Load() {
		t.Fatal("publication changed encoded frame payloads")
	}
	if counters := publication.Counters(); counters.Frames[0] == 0 || counters.Frames[1] == 0 || counters.AudioBytes == 0 {
		t.Fatalf("successful RTP writes were not accounted per encoding: %+v", counters)
	}
	// Once real bitrate measurements exist, one shared capacity update must
	// constrain the sum of both RID allocations after reserving Opus.
	for {
		_, rates := source.GetLayeredBitrate()
		if rates[0][0] > 0 && rates[1][0] > 0 {
			break
		}
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatal("publication did not measure both available encodings")
		}
	}
	publication.bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateCongested, 65_000)
	for publication.tracks[0].BandwidthRequested()+publication.tracks[1].BandwidthRequested() > 1_000 {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("simulcast allocations exceeded their shared post-audio capacity")
		}
	}
	if publication.LowestLayerBudget() != 1_000 {
		t.Fatal("paused higher output retained the lowest encoder's budget")
	}
	if publication.bandwidth.CongestionState() != bwe.CongestionStateNone || !publication.Counters().Limited {
		t.Fatalf("clear transport feedback hid the committed publication allocation deficit: state=%v counters=%+v low=%v high=%v", publication.bandwidth.CongestionState(), publication.Counters(), publication.tracks[0].IsDeficient(), publication.tracks[1].IsDeficient())
	}
	// Restore this allocation fixture's capacity explicitly. A congestion event
	// cannot prove an increase; this test covers RID reuse, not bandwidth probing.
	publication.bandwidth.target.Store(1_000_000)
	publication.allocator.SetChannelCapacity(936_000)
	check(publication.SetActiveCount(1))
	if publication.RequiredActiveCount() != 1 {
		t.Fatal("publication did not reduce its direct demand")
	}
	// Drain packets already admitted by the pacer before observing inactive output.
	for range 6 {
		write()
		time.Sleep(time.Second / 30)
	}
	high, low := received[1].Load(), received[0].Load()
	for range 6 {
		write()
		time.Sleep(time.Second / 30)
	}
	if received[1].Load() != high || received[0].Load() <= low {
		t.Fatalf("inactive high RID affected low or continued sending: high=%d->%d low=%d->%d limited=%t lowtrack=%+v hightrack=%+v", high, received[1].Load(), low, received[0].Load(), publication.Counters().Limited, publication.tracks[0].DebugInfo(), publication.tracks[1].DebugInfo())
	}
	if publication.Counters().Limited {
		t.Fatal("publication stayed limited after requested low output recovered and high was deactivated")
	}
	check(publication.SetActiveCount(2))
	for received[1].Load() <= high {
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatal("requested high RID did not resume after publisher activation")
		}
	}
	check(publication.Close())
	if len(source.GetDownTracks()) != 0 {
		t.Fatal("publication retained source outputs")
	}
}
