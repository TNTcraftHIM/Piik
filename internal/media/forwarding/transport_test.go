package forwarding

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func TestTransportVideoFeedbackAudioAndClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
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
	keyFrames := make(chan struct{}, 8)
	source, err := NewSource(SourceOptions{ID: "screen", StreamID: "fixture", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 300_000}, {Width: 16, Height: 16, Bitrate: 3_000_000}}, OnRTCP: func(_ int, packets []rtcp.Packet) {
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					select {
					case keyFrames <- struct{}{}:
					default:
					}
				}
			}
		}})
	check(err)
	defer source.Close()
	check(source.BindLayer(0, 1000, webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{codec}}))
	// This checks feedback routing independently of the buffer's bootstrap-PLI throttle.
	source.buffers[0].SetPLIThrottle(0)
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "audio", "fixture")
	check(err)
	demandWake := make(chan struct{}, 1)
	transport, err := NewTransport(TransportOptions{Source: source, Settings: settings,
		ConnectionID: "child", InitialBitrate: 1_000_000, Audio: audio, OnDemandChanged: func() {
			select {
			case demandWake <- struct{}{}:
			default:
			}
		}})
	check(err)
	defer transport.Close()
	transport.Output.SetMaxSpatialLayer(0)
	transport.SetAudioBitrate(64_000)
	if state := transport.Output.State(); state.VideoBudget != 936_000 {
		t.Fatalf("audio reservation did not reach the video codec budget: %+v", state)
	}
	if len(source.GetDownTracks()) != 0 {
		t.Fatal("unconnected transport claimed source output")
	}
	if transport.RequiredActiveCount() != 1 {
		t.Fatal("initial configured acquisition demand was lost")
	}
	mediaEngine := &webrtc.MediaEngine{}
	check(mediaEngine.RegisterDefaultCodecs())
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(mediaEngine, registry))
	check(webrtc.ConfigureTWCCSender(mediaEngine, registry))
	reports := &receiverReportGate{}
	registry.Add(reports)
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var videoPackets, audioPackets atomic.Uint32
	firstVideo := make(chan *rtp.Packet, 1)
	var recoveryTimestamp atomic.Uint32
	recovered := make(chan struct{}, 1)
	var readers sync.WaitGroup
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		readers.Add(1)
		defer readers.Done()
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			if len(packet.Payload) == 0 {
				continue
			}
			if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoPackets.Add(1)
				select {
				case firstVideo <- packet:
				default:
				}
				if packet.Timestamp == recoveryTimestamp.Load() {
					select {
					case recovered <- struct{}{}:
					default:
					}
				}
			} else {
				audioPackets.Add(1)
			}
		}
	})
	offer, err := transport.PC.CreateOffer(nil)
	check(err)
	gather := webrtc.GatheringCompletePromise(transport.PC)
	check(transport.PC.SetLocalDescription(offer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(receiver.SetRemoteDescription(*transport.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gather = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(transport.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(transport.SetConnected())
	check(transport.SetConnected())
	if len(source.GetDownTracks()) != 1 {
		t.Fatal("connected transport attached twice")
	}
	packetizer := rtp.NewPacketizer(1200, 96, 1000, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), 90_000)
	for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
		check(source.WriteRTP(0, packet))
	}
	firstFrame := false
	for !firstFrame {
		select {
		case packet := <-firstVideo:
			firstFrame = true
			recoveryTimestamp.Store(packet.Timestamp + 3000)
			for len(keyFrames) > 0 {
				<-keyFrames
			}
			check(receiver.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: packet.SSRC}}))
		case <-time.After(time.Second / 30):
			for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
				check(source.WriteRTP(0, packet))
			}
		case <-ctx.Done():
			t.Fatalf("missing first frame: %+v", transport.Output.State())
		}
	}
	select {
	case <-keyFrames:
	case <-time.After(time.Second):
		t.Fatalf("first-frame PLI never reached source; output=%+v statsPLI=%d", transport.Output.State(), transport.Output.GetTrackStats().Plis)
	}
	// Force exactly one local queue-admission loss. The following RTP packet
	// exposes its sequence gap to the receiver's normal NACK generator.
	transport.pacer.mu.Lock()
	transport.pacer.limit = 0
	transport.pacer.mu.Unlock()
	for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
		check(source.WriteRTP(0, packet))
	}
	for transport.Egress().DroppedPackets == 0 {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("local admission loss was not exercised")
		}
	}
	transport.pacer.mu.Lock()
	transport.pacer.limit = source.maxPackets
	transport.pacer.mu.Unlock()
	for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
		check(source.WriteRTP(0, packet))
	}
	select {
	case <-recovered:
	case <-ctx.Done():
		t.Fatal("local admission loss did not recover through library NACK")
	}
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	for {
		_, observed := transport.TargetBitrate()
		if videoPackets.Load() >= 15 && audioPackets.Load() >= 15 && observed {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("media or feedback missing: video=%d audio=%d observed=%v", videoPackets.Load(), audioPackets.Load(), observed)
		case <-ticker.C:
		}
		for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
			check(source.WriteRTP(0, packet))
		}
		check(audio.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}))
	}
	if egress := transport.Egress(); egress.Packets < 15 || egress.RTPBytes == 0 || egress.DroppedPackets != 1 {
		t.Fatalf("paced local egress disagrees with receiving media: %+v", egress)
	}
	if len(demandWake) == 0 || transport.RequiredActiveCount() != 1 {
		t.Fatal("typed direct-child demand was not signaled")
	}
	// Raise subscribed demand without inventing an available layer. TWCC alone
	// cannot establish the RR readiness required by the library padding sender.
	transport.Output.DownTrack.SetMaxSpatialLayer(1)
	if delta, _ := transport.Output.probeDemand(); delta <= 0 {
		t.Fatal("no-RR fixture did not establish dormant upper demand")
	}
	transport.mediaActivity()
	transport.mu.Lock()
	ready := transport.paddingReady
	transport.mu.Unlock()
	if ready || transport.prober.IsRunning() {
		t.Fatal("transport probed before a receiver report")
	}
	// A muted library sender returns zero padding bytes despite a connected PC
	// and valid RR. Its probe must finish, and inconclusive feedback must not
	// promote the BWE's internal initial-capacity sentinel into a codec budget.
	transport.Output.Mute(true)
	before, _ := transport.TargetBitrate()
	reports.allow.Store(true)
	seenProbe := false
	for {
		transport.mediaActivity()
		transport.mu.Lock()
		active := transport.probe.Id != ccutils.ProbeClusterIdInvalid
		transport.mu.Unlock()
		seenProbe = seenProbe || active
		if seenProbe && !active && !transport.prober.IsRunning() {
			break
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("zero-write probe did not retire within its library duration/settle bound")
		}
	}
	if after, _ := transport.TargetBitrate(); after != before {
		t.Fatalf("zero-write probe manufactured a budget: before=%d after=%d", before, after)
	}
	check(transport.Close())
	check(transport.Close())
	check(receiver.Close())
	readers.Wait()
	if len(source.GetDownTracks()) != 0 || transport.SetConnected() == nil || transport.RequiredActiveCount() != 0 {
		t.Fatal("closed transport retained a source subscription")
	}
}

type receiverReportGate struct {
	interceptor.NoOp
	allow atomic.Bool
}

func (gate *receiverReportGate) NewInterceptor(string) (interceptor.Interceptor, error) {
	return gate, nil
}

func (gate *receiverReportGate) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		if gate.allow.Load() {
			return writer.Write(packets, attributes)
		}
		var filtered []rtcp.Packet
		for _, packet := range packets {
			if _, report := packet.(*rtcp.ReceiverReport); !report {
				filtered = append(filtered, packet)
			}
		}
		if len(filtered) == 0 {
			return 0, nil
		}
		return writer.Write(filtered, attributes)
	})
}

type heldPacketPacer struct {
	pacer.Pacer
	packets []*pacer.Packet
}

func (held *heldPacketPacer) Enqueue(packet *pacer.Packet) {
	held.packets = append(held.packets, packet)
}

type countingPacketWriter struct{ bytes int }

func (writer *countingPacketWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	written := header.MarshalSize() + len(payload)
	writer.bytes += written
	return written, nil
}

func (*countingPacketWriter) Write([]byte) (int, error) { panic("unexpected byte write") }

func TestBoundedPacerReleasesPacketsAndIsolatesBlockedQueue(t *testing.T) {
	log := logger.GetDiscardLogger()
	sender := pacer.NewPassThrough(log, nil)
	held := &heldPacketPacer{Pacer: sender}
	queue := newBoundedPacer(held, log, 2)
	defer queue.Stop()
	healthy := newBoundedPacer(sender, log, 2)
	defer healthy.Stop()
	writer := &countingPacketWriter{}
	var originals []*pacer.Packet
	packet := func() *pacer.Packet {
		header := &rtp.Header{Version: 2, SSRC: 1}
		payload := make([]byte, 100)
		original := &pacer.Packet{Header: header, HeaderSize: header.MarshalSize(),
			HeaderPool: &sync.Pool{}, Pool: &sync.Pool{}, PoolEntity: &payload,
			Payload: payload, WriteStream: writer}
		originals = append(originals, original)
		return original
	}
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	if len(queue.pending) != 2 || queue.stats().DroppedPackets != 1 || len(held.packets) != 2 {
		t.Fatalf("queue exceeded its bound: pending=%d stats=%+v", len(queue.pending), queue.stats())
	}
	healthy.Enqueue(packet())
	if healthy.stats().Packets != 1 || queue.stats().Packets != 0 {
		t.Fatal("held sibling blocked a ready packet")
	}
	sender.Enqueue(held.packets[0])
	queue.Enqueue(packet())
	queue.Stop()
	queue.Stop()
	queue.Enqueue(packet())
	// Upstream may still hold header-free tickets when it stops. Visiting one
	// after cancellation must neither send nor return the original a second time.
	for _, proxy := range held.packets[1:] {
		sender.Enqueue(proxy)
	}
	if stats := queue.stats(); stats != (EgressStats{Packets: 1, RTPBytes: 112, DroppedPackets: 4}) {
		t.Fatalf("incorrect sent/drop accounting: %+v", stats)
	}
	for _, original := range originals {
		if original.Header != nil || original.Payload != nil || original.WriteStream != nil || original.PoolEntity != nil {
			t.Fatalf("send/Stop retained pooled packet ownership: %+v", original)
		}
	}
	if writer.bytes != 224 {
		t.Fatalf("canceled packets reached the writer: %d bytes", writer.bytes)
	}
}

func TestBoundedPacerCanceledProbesRetainAdmission(t *testing.T) {
	log := logger.GetDiscardLogger()
	sender := pacer.NewPassThrough(log, nil)
	held := &heldPacketPacer{Pacer: sender}
	queue := newBoundedPacer(held, log, 2)
	defer queue.Stop()
	packet := func() *pacer.Packet {
		return &pacer.Packet{Header: &rtp.Header{Version: 2}, HeaderSize: 12,
			Payload: make([]byte, 100), WriteStream: &countingPacketWriter{}, IsProbe: true, ProbeClusterId: 1}
	}
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	for range 10 {
		queue.cancelProbes(1)
		queue.Enqueue(packet())
	}
	if len(queue.pending) != 2 || len(held.packets) != 2 || queue.stats().DroppedPackets != 12 {
		t.Fatalf("canceled proxies freed admission before dequeue: pending=%d queued=%d stats=%+v",
			len(queue.pending), len(held.packets), queue.stats())
	}
	sender.Enqueue(held.packets[0])
	queue.Enqueue(packet())
	if len(queue.pending) != 2 || len(held.packets) != 3 {
		t.Fatal("actual dequeue did not return its admission slot")
	}
	queue.Stop()
	for _, proxy := range held.packets[1:] {
		sender.Enqueue(proxy)
	}
	if stats := queue.stats(); stats.Packets != 0 || stats.DroppedPackets != 13 {
		t.Fatalf("canceled ownership was sent or retired twice: %+v", stats)
	}
}

func BenchmarkBoundedPacerAdmission(b *testing.B) {
	log := logger.GetDiscardLogger()
	for _, bounded := range []bool{false, true} {
		name := "pass-through"
		if bounded {
			name = "bounded-admission"
		}
		b.Run(name, func(b *testing.B) {
			var queue pacer.Pacer = pacer.NewPassThrough(log, nil)
			if bounded {
				queue = newBoundedPacer(queue, log, 500)
			}
			defer queue.Stop()
			writer := &countingPacketWriter{}
			header := &rtp.Header{Version: 2, SSRC: 1}
			payload := make([]byte, 1200)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				packet := pacer.PacketFactory.Get().(*pacer.Packet)
				*packet = pacer.Packet{Header: header, HeaderSize: header.MarshalSize(), Payload: payload, WriteStream: writer}
				queue.Enqueue(packet)
			}
		})
	}
}
