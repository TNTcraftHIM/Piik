package mediaedge

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
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
		if observed && seen[0].Width == 320 && frames[0] >= 3 && frames[1] >= beforeShared[1]+3 &&
			weak.transport.CurrentSource() == secondLow.transport.CurrentSource() {
			break
		}
	}
	_, secondObserved := secondLow.transport.TargetBitrate()
	if !secondObserved || seen[0].Width != 320 || frames[0] < 3 || frames[1] < beforeShared[1]+3 ||
		weak.transport.CurrentSource() != secondLow.transport.CurrentSource() {
		t.Fatalf("compatible low consumers did not share delivery: sizes=%+v frames=%v", seen, frames)
	}
	checkMembership := func(split bool) bool {
		source.writeMu.Lock()
		defer source.writeMu.Unlock()
		weakGroup, secondGroup := source.memberships[weak.transport], source.memberships[secondLow.transport]
		if weakGroup == nil || secondGroup == nil || (weakGroup != secondGroup) != split ||
			weak.transport.CurrentSource() != weakGroup.media.Source ||
			secondLow.transport.CurrentSource() != secondGroup.media.Source {
			return false
		}
		weakBudget := uint32(300_000)
		if split {
			weakBudget = 80_000
		}
		return weakGroup.budget == weakBudget && secondGroup.budget == 300_000 &&
			weak.transport.Output.State().Current == 0 && secondLow.transport.Output.State().Current == 0
	}
	for _, split := range []bool{true, false} {
		before := frames
		budget := int64(300_000)
		if split {
			budget = 80_000
		}
		for frame := 0; frame < 120; frame++ {
			weak.transport.Output.SetBudget(budget)
			secondLow.transport.Output.SetBudget(300_000)
			feed()
			checkSharedRun()
			if checkMembership(split) && frames[0] >= before[0]+3 && frames[1] >= before[1]+3 {
				break
			}
		}
		if !checkMembership(split) || frames[0] < before[0]+3 || frames[1] < before[1]+3 {
			t.Fatalf("budget membership transition failed: split=%v frames=%v->%v weak=%+v second=%+v",
				split, before, frames, weak.transport.Output.State(), secondLow.transport.Output.State())
		}
		t.Logf("shared decoder budget transition: split=%v weakBudget=%d secondBudget=300000 frames=%v->%v",
			split, budget, before, frames)
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
	t.Log("640x360 raw forwarding; lower consumers shared, split at 80/300 kbps, rejoined at 300/300 kbps and independently retired with one decoder process")
}

// Forced direct-child budgets exercise real per-group WebRTC spatial adaptation;
// they do not simulate transport loss or prove bandwidth-estimator behavior.
func TestRelayIndependentSpatialFixture(t *testing.T) {
	executable, fixture := os.Getenv("SCREENER_NATIVE_CAPTURE"), os.Getenv("SCREENER_GROUP_MOTION_INPUT")
	if executable == "" || fixture == "" {
		t.Skip("set SCREENER_NATIVE_CAPTURE and SCREENER_GROUP_MOTION_INPUT")
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	input, err := os.Open(fixture)
	check(err)
	defer input.Close()
	var motion [][]byte
	decoder := json.NewDecoder(io.LimitReader(input, 16*1024*1024))
	for {
		var row struct {
			Width, Height uint32
			Recovery      bool
			DataHex       string
		}
		err := decoder.Decode(&row)
		if err == io.EOF {
			break
		}
		check(err)
		if len(motion) >= 60 || row.Width != 1280 || row.Height != 720 || len(motion) == 0 && !row.Recovery {
			t.Fatal("expected bounded 1280x720 motion input beginning with recovery")
		}
		data, err := hex.DecodeString(row.DataHex)
		check(err)
		motion = append(motion, data)
	}
	if len(motion) != 60 {
		t.Fatal("motion fixture must contain 60 decoder-safe frames")
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 2, 2, nil)
	check(err)
	defer source.Close()
	source.relay = &relayDerivation{source: source, options: RelayOptions{
		CaptureProcess: executable,
		Capabilities:   nativecapture.Capabilities{SoftwareVP8: true, Adapters: []nativecapture.Adapter{{Index: 0}}},
	}}
	check(source.SetRelayProfile(nativecapture.VideoProfile{
		Width: 1920, Height: 1080, Framerate: 30, Bitrate: 5_000_000, Preference: "maintain-framerate",
	}))
	a, receiverA, packetsA := connectedReceiver(t, engine, source, "spatial-a")
	b, receiverB, packetsB := connectedReceiver(t, engine, source, "spatial-b")
	defer receiverA.Close()
	defer receiverB.Close()
	packetizer := rtp.NewPacketizer(videoPacketMTU, vp8PayloadType, 1, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), videoClockRate)
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	ctx, cancel := context.WithTimeout(t.Context(), 35*time.Second)
	defer cancel()
	type receivedFrame struct {
		Index         int
		Width, Height uint32
		Recovery      bool
		Data          []byte
		PTS           time.Duration
	}
	var output [2][]receivedFrame
	var seen [2]mediacodec.VideoSize
	var frames [2]int
	var anchor [2]uint32
	var waiting = [2]bool{true, true}
	var assembled [2]relayVideoInput
	for child := range assembled {
		assembled[child] = relayVideoInput{codec: "vp8", onPacketDropped: func() { waiting[child] = true }}
	}
	var packetsSent, bytesSent uint32
	index := 0
	record := false
	feed := func() {
		t.Helper()
		for _, packet := range packetizer.Packetize(motion[index%len(motion)], videoClockRate/30) {
			check(source.WriteRTP(packet))
			packetsSent++
			bytesSent += uint32(len(packet.Payload))
			if packet.Marker {
				check(source.SenderReport(&rtcp.SenderReport{SSRC: 1, RTPTime: packet.Timestamp,
					NTPTime: uint64(mediatransportutil.ToNtpTime(time.Now())), PacketCount: packetsSent, OctetCount: bytesSent}))
			}
		}
		index++
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		for child, channel := range []<-chan *rtp.Packet{packetsA, packetsB} {
		drain:
			for {
				select {
				case packet := <-channel:
					check(assembled[child].push(packet))
					for {
						sample, timestamp := assembled[child].pop()
						if sample == nil {
							break
						}
						frame, err := assembled[child].frame(sample.Data)
						check(err)
						seen[child] = mediacodec.VideoSize{Width: frame.Width, Height: frame.Height}
						frames[child]++
						if !record || waiting[child] && !frame.KeyFrame {
							continue
						}
						if len(output[child]) == 0 {
							anchor[child] = timestamp
						}
						waiting[child] = false
						output[child] = append(output[child], receivedFrame{Index: len(output[child]),
							Width: frame.Width, Height: frame.Height, Recovery: frame.KeyFrame, Data: frame.Data,
							PTS: time.Duration(uint32(timestamp-anchor[child])) * time.Second / videoClockRate})
					}
				default:
					break drain
				}
			}
		}
	}
	for range 60 {
		feed()
	}
	check(a.SetTargetLayer(0))
	check(b.SetTargetLayer(0))
	for frame := 0; frame < 240; frame++ {
		a.transport.Output.SetBudget(1_250_000)
		b.transport.Output.SetBudget(1_250_000)
		feed()
		if seen[0].Width == 640 && seen[1].Width == 640 && a.transport.Output.State().Current == 0 && b.transport.Output.State().Current == 0 {
			break
		}
	}
	if seen[0].Width != 640 || seen[1].Width != 640 {
		t.Fatalf("shared derived warmup failed: sizes=%+v frames=%v", seen, frames)
	}
	source.relay.mu.Lock()
	run := source.relay.run
	source.relay.mu.Unlock()
	if run == nil {
		t.Fatal("motion derivation did not start")
	}
	before := frames
	record = true
	for range 600 {
		a.transport.Output.SetBudget(80_000)
		b.transport.Output.SetBudget(1_250_000)
		feed()
		source.relay.mu.Lock()
		same := source.relay.run == run
		source.relay.mu.Unlock()
		if !same {
			t.Fatal("independent budgets replaced the shared decoder process")
		}
		select {
		case <-run.done:
			t.Fatalf("shared motion derivation failed: %v", context.Cause(run.ctx))
		default:
		}
	}
	if path := os.Getenv("SCREENER_GROUP_OUTPUT"); path != "" {
		file, err := os.Create(path)
		check(err)
		check(json.NewEncoder(file).Encode(output))
		check(file.Close())
	}
	source.writeMu.Lock()
	ga, gb := source.memberships[a.transport], source.memberships[b.transport]
	independent := ga != nil && gb != nil && ga != gb && ga.budget == 80_000 && gb.budget == 1_250_000 &&
		a.transport.CurrentSource() == ga.media.Source && b.transport.CurrentSource() == gb.media.Source
	source.writeMu.Unlock()
	if !independent || seen[0].Width != 320 || seen[0].Height != 180 || seen[1].Width != 640 || seen[1].Height != 360 ||
		frames[0] <= before[0]+30 || frames[1] <= before[1]+30 || a.transport.Output.State().Current != 0 || b.transport.Output.State().Current != 0 {
		t.Fatalf("independent spatial adaptation missing: independent=%v sizes=%+v frames=%v->%v", independent, seen, before, frames)
	}
	check(a.Close())
	check(b.Close())
	select {
	case <-run.done:
	case <-time.After(2 * time.Second):
		t.Fatal("last spatial consumer did not retire the decoder process")
	}
	t.Logf("one decoder, two budget-owned encoders: A=80kbps 320x180 B=1250kbps 640x360 frames=%v->%v exported=%d/%d", before, frames, len(output[0]), len(output[1]))
}
