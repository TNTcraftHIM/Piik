package mediaedge

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/livekit/mediatransportutil"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/transport/v4/vnet"
	"github.com/pion/webrtc/v4"
)

// One real VP8 derived process, no desktop capture. The link changes capacity;
// production BWE, output admission and codec controls supply every adaptation.
func TestRelayNetworkVP8Fixture(t *testing.T) {
	if os.Getenv("PIIK_RELAY_NETWORK") == "" {
		t.Skip("set PIIK_RELAY_NETWORK=1, PIIK_NATIVE_CAPTURE and PIIK_ENCODED_FIXTURE")
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	input, err := os.Open(os.Getenv("PIIK_ENCODED_FIXTURE"))
	check(err)
	defer input.Close()
	var motion [][]byte
	decoder := json.NewDecoder(input)
	for records := 0; ; records++ {
		var row struct {
			FrameIndex, Layer int
			DataHex           string
		}
		if err = decoder.Decode(&row); err == io.EOF {
			break
		}
		check(err)
		if records >= 96 || row.FrameIndex < 0 || row.FrameIndex >= 40 || row.Layer < 0 || row.Layer > 2 || len(row.DataHex) > 8*1024*1024 {
			t.Fatal("encoded fixture exceeded its bounds")
		}
		if row.Layer == 2 && row.FrameIndex < 16 {
			data, decodeErr := hex.DecodeString(row.DataHex)
			check(decodeErr)
			motion = append(motion, data)
		}
	}
	if len(motion) != 16 {
		t.Fatal("fixture needs its complete first sixteen high outputs")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", InitialBitrate: 1_200_000})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 2, 2, nil)
	check(err)
	defer source.Close()
	source.relay = &relayDerivation{source: source, options: RelayOptions{
		CaptureProcess: os.Getenv("PIIK_NATIVE_CAPTURE"),
		Capabilities:   nativecapture.Capabilities{SoftwareVP8: true, Adapters: []nativecapture.Adapter{{Index: 0}}},
	}}
	check(source.SetRelayProfile(nativecapture.VideoProfile{Width: 1280, Height: 720,
		Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}))
	router, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: "10.0.0.0/24", MinDelay: 20 * time.Millisecond,
		LoggerFactory: logging.NewDefaultLoggerFactory()})
	check(err)
	sendNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.1"}})
	check(err)
	check(router.AddNet(sendNet))
	engine.settings = webrtc.SettingEngine{}
	engine.settings.SetNet(sendNet)
	engine.settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	engine.settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	link := vnet.NewTBFQueue(6_000_000, 2400, 2400)
	type deliveredFrame struct {
		Index, Layer, Width, Height int
		PTS                         time.Duration
		Recovery                    bool
		Data                        []byte
		ReceivedAt, DeliveryAge     time.Duration
	}
	var receivedMu sync.Mutex
	var delivered [2][]deliveredFrame
	var lost [2]int
	var intervalPacketFrames [2]int
	var intervalPacketBytes [2]int
	var intervalPacketAge [2]time.Duration
	var sourceOrigin time.Time
	var inputTimes []time.Time
	var children [2]*Edge
	var receivers [2]*webrtc.PeerConnection
	for child, address := range []string{"10.0.0.2", "10.0.0.3"} {
		network, netErr := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{address}})
		check(netErr)
		if child == 1 {
			queue, queueErr := vnet.NewQueue(network, link)
			check(queueErr)
			defer queue.Close()
			check(router.AddNet(queue))
		} else {
			check(router.AddNet(network))
		}
		settings := webrtc.SettingEngine{}
		settings.SetNet(network)
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
		media := &webrtc.MediaEngine{}
		check(media.RegisterDefaultCodecs())
		registry := &interceptor.Registry{}
		check(webrtc.RegisterDefaultInterceptors(media, registry))
		check(webrtc.ConfigureTWCCSender(media, registry))
		receiver, createErr := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
		check(createErr)
		receivers[child] = receiver
		defer receiver.Close()
		receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			waitingKey, anchored := true, false
			var originRTP uint32
			video := relayVideoInput{codec: "vp8", onPacketDropped: func() {
				waitingKey = true
				receivedMu.Lock()
				lost[child]++
				receivedMu.Unlock()
				_ = receiver.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
			}}
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				receivedMu.Lock()
				intervalPacketBytes[child] += len(packet.Payload)
				if len(packet.Payload) > 0 && packet.Marker {
					intervalPacketFrames[child]++
				}
				if anchored && len(packet.Payload) > 0 && !packet.Padding {
					inputIndex := int((uint64(packet.Timestamp-originRTP) + 1500) / 3000)
					if inputIndex < len(inputTimes) {
						intervalPacketAge[child] = max(intervalPacketAge[child], time.Since(inputTimes[inputIndex]))
					}
				}
				receivedMu.Unlock()
				if readErr = video.push(packet); readErr != nil {
					t.Error(readErr)
					return
				}
				for {
					sample, timestamp := video.pop()
					if sample == nil {
						break
					}
					frame, frameErr := video.frame(sample.Data)
					if frameErr != nil || waitingKey && !frame.KeyFrame {
						continue
					}
					waitingKey = false
					if !anchored {
						for index, original := range motion {
							if bytes.Equal(original, sample.Data) {
								originRTP = timestamp - uint32(index*3000)
								anchored = true
								break
							}
						}
						if !anchored {
							continue
						}
					}
					pts := time.Duration(uint32(timestamp-originRTP)) * time.Second / videoClockRate
					now := time.Now()
					receivedMu.Lock()
					inputIndex := int((uint64(timestamp-originRTP) + 1500) / 3000)
					age := time.Duration(-1)
					if inputIndex < len(inputTimes) {
						age = now.Sub(inputTimes[inputIndex])
					}
					if len(delivered[child]) < 1200 {
						delivered[child] = append(delivered[child], deliveredFrame{Index: len(delivered[child]),
							Layer: int(frame.Width / 640), Width: int(frame.Width), Height: int(frame.Height), PTS: pts,
							Recovery: frame.KeyFrame, Data: sample.Data, ReceivedAt: now.Sub(sourceOrigin), DeliveryAge: age})
					}
					receivedMu.Unlock()
				}
			}
		})
		children[child], err = engine.NewEdge(source, EdgeOptions{ConnectionID: address})
		check(err)
	}
	check(router.Start())
	defer router.Stop()
	for index, child := range children {
		connectEdgeToReceiver(t, child, receivers[index])
	}
	packetizer := rtp.NewPacketizer(videoPacketMTU, vp8PayloadType, 1, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), videoClockRate)
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	receivedMu.Lock()
	sourceOrigin = time.Now()
	receivedMu.Unlock()
	lastReport := sourceOrigin
	var inputPackets, inputBytes uint32
	type observation struct {
		Second                      float64
		Capacity, CodecBudget       uint32
		VideoBudget                 int64
		Target, Current             int32
		DerivedFrames, DerivedBytes uint64
		ReceivedFrames              [2]int
		ReceivedBytes               [2]int
		MaximumAge                  [2]time.Duration
		PacketFrames                [2]int
		PacketBytes                 [2]int
		MaximumPacketAge            [2]time.Duration
	}
	var observations []observation
	var previousFrames [2]int
	var process *relayRun
	var processStarts []float64
	var constrained, recovered bool
	for frameIndex := 0; ; frameIndex++ {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		now := time.Now()
		elapsed := now.Sub(sourceOrigin)
		if elapsed >= 30*time.Second {
			break
		}
		capacity := uint32(6_000_000)
		if elapsed >= 5*time.Second && elapsed < 18*time.Second {
			capacity = 120_000
		}
		link.SetRate(int(capacity))
		receivedMu.Lock()
		inputTimes = append(inputTimes, now)
		receivedMu.Unlock()
		for _, packet := range packetizer.Packetize(motion[frameIndex%len(motion)], 3000) {
			check(source.WriteRTP(packet))
			inputPackets++
			inputBytes += uint32(len(packet.Payload))
			if packet.Marker {
				check(source.SenderReport(&rtcp.SenderReport{SSRC: 1, RTPTime: packet.Timestamp,
					NTPTime: uint64(mediatransportutil.ToNtpTime(now)), PacketCount: inputPackets, OctetCount: inputBytes}))
			}
		}
		source.relay.mu.Lock()
		if run := source.relay.run; run != nil {
			if process != nil && process != run {
				select {
				case <-process.done:
				default:
					t.Error("derived codec processes overlapped")
				}
			}
			if process != run {
				processStarts = append(processStarts, elapsed.Seconds())
			}
			process = run
		}
		source.relay.mu.Unlock()
		if now.Sub(lastReport) >= time.Second {
			state, plan := children[1].transport.Output.State(), source.relayPlan()
			physical := 0
			source.writeMu.Lock()
			currentSource := children[1].transport.CurrentSource()
			if group := source.groupForMedia(currentSource); group != nil {
				physical = group.slot
			}
			source.writeMu.Unlock()
			row := observation{Second: elapsed.Seconds(), Capacity: capacity, CodecBudget: plan.controls.Bitrates[physical],
				VideoBudget: state.VideoBudget, Target: state.Target, Current: state.Current}
			if buffer := currentSource.GetAllBuffers()[0]; buffer != nil {
				if stats := buffer.GetStats(); stats != nil {
					row.DerivedFrames, row.DerivedBytes = uint64(stats.Frames), stats.Bytes
				}
			}
			receivedMu.Lock()
			row.PacketFrames, row.PacketBytes, row.MaximumPacketAge = intervalPacketFrames, intervalPacketBytes, intervalPacketAge
			intervalPacketFrames, intervalPacketBytes, intervalPacketAge = [2]int{}, [2]int{}, [2]time.Duration{}
			for child := range delivered {
				for _, output := range delivered[child][previousFrames[child]:] {
					row.ReceivedFrames[child]++
					row.ReceivedBytes[child] += len(output.Data)
					row.MaximumAge[child] = max(row.MaximumAge[child], output.DeliveryAge)
					if child == 1 && capacity == 120_000 && output.Width == 320 && state.VideoBudget < int64(plan.output.Bitrate) {
						constrained = true
					}
					if child == 1 && elapsed > 18*time.Second && output.Width == 640 && output.PTS > 18*time.Second {
						recovered = true
					}
					if child == 0 && output.Width != 640 {
						t.Error("healthy child lost original representation")
					}
				}
				previousFrames[child] = len(delivered[child])
			}
			receivedMu.Unlock()
			observations = append(observations, row)
			t.Logf("%+.1fs capacity=%d budget=%d codec=%d output=%d/%d assembled=%v packetFrames=%v packetBytes=%v maxPacketAge=%v maxAUAge=%v",
				row.Second, row.Capacity, row.VideoBudget, row.CodecBudget, row.Target, row.Current, row.ReceivedFrames, row.PacketFrames, row.PacketBytes, row.MaximumPacketAge, row.MaximumAge)
			lastReport = now
		}
	}
	check(source.Close())
	for _, receiver := range receivers {
		check(receiver.Close())
	}
	receivedMu.Lock()
	defer receivedMu.Unlock()
	// The last reporting tick precedes shutdown; include its unreported tail
	// with the same original-size and post-release capture-time requirements.
	for _, output := range delivered[1][previousFrames[1]:] {
		if output.ReceivedAt > 18*time.Second && output.Width == 640 && output.PTS > 18*time.Second {
			recovered = true
		}
	}
	outputPath := os.Getenv("PIIK_ENCODED_OUTPUT")
	if outputPath == "" {
		t.Fatal("PIIK_ENCODED_OUTPUT must name the ignored received-frame artifact")
	}
	data, err := json.Marshal(delivered)
	check(err)
	check(os.WriteFile(outputPath, data, 0600))
	data, err = json.MarshalIndent(struct {
		Observations           []observation
		DroppedFrames          [2]int
		ProcessStarts          []float64
		Constrained, Recovered bool
	}{observations, lost, processStarts, constrained, recovered}, "", "  ")
	check(err)
	check(os.WriteFile(outputPath+".observations.json", data, 0600))
	if !constrained || !recovered || process == nil || lost[0] != 0 {
		t.Fatalf("actual codec/network result: constrained=%v recovered=%v process=%v loss=%v", constrained, recovered, process != nil, lost)
	}
}
