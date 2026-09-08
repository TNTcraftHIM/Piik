package mediaedge

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/livekit/mediatransportutil"
	mediacodec "github.com/livekit/mediatransportutil/pkg/codec"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

// Explicit small native-codec acceptance, never launched by the ordinary suite.
// Forced layer demand tests derivation ownership, not network adaptation.
func TestRelayDerivationFixture(t *testing.T) {
	executable, fixture := os.Getenv("SCREENER_NATIVE_CAPTURE"), os.Getenv("SCREENER_ENCODED_FIXTURE")
	if executable == "" || fixture == "" {
		t.Skip("set SCREENER_NATIVE_CAPTURE and SCREENER_ENCODED_FIXTURE for native relay acceptance")
	}
	input, err := os.Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	var row struct {
		Layer   int
		DataHex string
	}
	decoder := json.NewDecoder(input)
	for index := 0; index < 3; index++ {
		if err = decoder.Decode(&row); err != nil {
			t.Fatal(err)
		}
		if row.Layer == 2 {
			break
		}
	}
	data, err := hex.DecodeString(row.DataHex)
	if err != nil || row.Layer != 2 {
		t.Fatal("fixture has no first-frame high recovery output")
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("vp8", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	source.relay = &relayDerivation{source: source, options: RelayOptions{
		CaptureProcess: executable,
		Capabilities:   nativecapture.Capabilities{SoftwareVP8: true, Adapters: []nativecapture.Adapter{{Index: 0}}},
	}}
	profile := nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}
	if err = source.SetRelayProfile(profile); err != nil {
		t.Fatal(err)
	}
	healthy, receiverA, packetsA := connectedReceiver(t, engine, source, "relay-healthy")
	weak, receiverB, packetsB := connectedReceiver(t, engine, source, "relay-weak")
	t.Cleanup(func() { _ = receiverA.Close() })
	t.Cleanup(func() { _ = receiverB.Close() })
	packetizer := rtp.NewPacketizer(videoPacketMTU, vp8PayloadType, 1, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), videoClockRate)
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	var seen [2]mediacodec.VideoSize
	var frames [2]int
	var packetsSent, bytesSent uint32
	feed := func() {
		t.Helper()
		for _, packet := range packetizer.Packetize(data, videoClockRate/30) {
			if err = source.WriteRTP(packet); err != nil {
				t.Fatal(err)
			}
			packetsSent++
			bytesSent += uint32(len(packet.Payload))
			if packet.Marker {
				_ = source.SenderReport(&rtcp.SenderReport{SSRC: 1, RTPTime: packet.Timestamp,
					NTPTime: uint64(mediatransportutil.ToNtpTime(time.Now())), PacketCount: packetsSent, OctetCount: bytesSent})
			}
		}
		<-ticker.C
		for child, channel := range []<-chan *rtp.Packet{packetsA, packetsB} {
		drain:
			for {
				select {
				case packet := <-channel:
					var header mediacodec.VP8
					if header.Unmarshal(packet.Payload) == nil {
						size := mediacodec.ExtractVP8VideoSize(&header, packet.Payload)
						if size.Width > 0 {
							seen[child] = size
						}
					}
					if len(packet.Payload) > 0 && packet.Marker {
						frames[child]++
					}
				default:
					break drain
				}
			}
		}
	}
	for frame := 0; frame < 60; frame++ {
		feed()
	}
	if frames[0] == 0 || frames[1] == 0 {
		t.Fatalf("raw warmup did not deliver both children: %v", frames)
	}
	source.relay.mu.Lock()
	startedEarly := source.relay.run != nil
	source.relay.mu.Unlock()
	if startedEarly {
		t.Fatal("healthy raw forwarding unnecessarily started a decoder")
	}
	if err = weak.SetTargetLayer(0); err != nil {
		t.Fatal(err)
	}
	// Allow the framework's existing four-second screen-share bitrate window.
	for frame := 0; frame < 240 && seen[1].Width != 320; frame++ {
		weak.transport.Output.SetBudget(300_000)
		feed()
	}
	if seen[0].Width != 640 || seen[1].Width != 320 || healthy.transport.Output.State().Current != 1 {
		source.relay.mu.Lock()
		if source.relay.run != nil {
			t.Logf("derived process cause=%v pending=%d", context.Cause(source.relay.run.ctx), len(source.relay.run.packets))
		}
		source.relay.mu.Unlock()
		_, observed := weak.transport.TargetBitrate()
		t.Logf("relay plan=%+v feedback=%v ceilings=%v", source.relayPlan(), observed, source.outputBitrates)
		available, rates := source.media.GetLayeredBitrate()
		t.Logf("actual lower format=%x available=%v rates=%v", source.formats[0].Load(), available, rates)
		for layer, buffer := range source.media.GetAllBuffers() {
			if buffer == nil {
				continue
			}
			if stats := buffer.GetStats(); stats != nil {
				t.Logf("layer=%d frames=%d packets=%d bytes=%d", layer, stats.Frames, stats.Packets, stats.Bytes)
			}
		}
		t.Fatalf("derived low and preserved raw high not delivered: sizes=%+v frames=%v low=%+v", seen, frames, weak.transport.Output.State())
	}
	source.relay.mu.Lock()
	run := source.relay.run
	source.relay.mu.Unlock()
	if run == nil {
		t.Fatal("no owned shared decoder process")
	}
	beforeChange := frames
	profile.Preference = "maintain-resolution"
	if err = source.SetRelayProfile(profile); err != nil {
		t.Fatal(err)
	}
	select {
	case <-run.done:
	case <-time.After(2 * time.Second):
		t.Fatal("old relay settings kept a stale decoder process alive")
	}
	for frame := 0; frame < 90; frame++ {
		weak.transport.Output.SetBudget(300_000)
		feed()
		if frames[1] > beforeChange[1]+2 {
			break
		}
	}
	source.relay.mu.Lock()
	replacement := source.relay.run
	source.relay.mu.Unlock()
	if replacement == nil || replacement == run || frames[0] <= beforeChange[0] || frames[1] <= beforeChange[1] {
		t.Fatal("live relay settings stopped healthy forwarding or failed to replace the derived output")
	}
	run = replacement
	if err = healthy.Close(); err != nil {
		t.Fatal(err)
	}
	if err = receiverA.Close(); err != nil {
		t.Fatal(err)
	}
	secondLow, secondReceiver, secondPackets := connectedReceiver(t, engine, source, "relay-second-low")
	t.Cleanup(func() { _ = secondReceiver.Close() })
	packetsA = secondPackets
	seen[0], frames[0] = mediacodec.VideoSize{}, 0
	if err = secondLow.SetTargetLayer(0); err != nil {
		t.Fatal(err)
	}
	beforeShared := frames
	checkSharedRun := func() {
		t.Helper()
		source.relay.mu.Lock()
		same := source.relay.run == run
		source.relay.mu.Unlock()
		select {
		case <-run.done:
			t.Fatal("a compatible consumer retired the shared derivation")
		default:
		}
		if !same {
			t.Fatal("compatible consumers created a replacement derivation")
		}
	}
	for frame := 0; frame < 120; frame++ {
		weak.transport.Output.SetBudget(300_000)
		secondLow.transport.Output.SetBudget(300_000)
		feed()
		checkSharedRun()
		_, observed := secondLow.transport.TargetBitrate()
		if observed && seen[0].Width == 320 && frames[0] >= 3 && frames[1] >= beforeShared[1]+3 {
			break
		}
	}
	_, secondObserved := secondLow.transport.TargetBitrate()
	if !secondObserved || seen[0].Width != 320 || frames[0] < 3 || frames[1] < beforeShared[1]+3 {
		t.Fatalf("compatible low consumers did not share delivery: sizes=%+v frames=%v", seen, frames)
	}
	if err = weak.Close(); err != nil {
		t.Fatal(err)
	}
	beforeRetire := frames[0]
	for frame := 0; frame < 30 && frames[0] < beforeRetire+3; frame++ {
		secondLow.transport.Output.SetBudget(300_000)
		feed()
		checkSharedRun()
	}
	if frames[0] < beforeRetire+3 {
		t.Fatal("retiring one consumer stopped the other consumer's shared output")
	}
	if err = secondLow.Close(); err != nil {
		t.Fatal(err)
	}
	// Only the last lower-output consumer retires the derivation.
	for frame := 0; frame < 3; frame++ {
		feed()
	}
	select {
	case <-run.done:
	case <-time.After(2 * time.Second):
		t.Fatal("unused native relay process did not retire")
	}
	t.Log("640x360 raw forwarding; two 320x180 consumers reused one derivation, independently retired")
}
