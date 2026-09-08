package mediaedge

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

// Explicit codec gate input; ordinary unit checks do not build/run a native codec.
func TestEncodedGroupVP8Fixture(t *testing.T) {
	inputPath := os.Getenv("SCREENER_ENCODED_FIXTURE")
	if inputPath == "" {
		t.Skip("set SCREENER_ENCODED_FIXTURE to the bounded VP8 fixture JSONL")
	}
	input, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	type fixtureFrame struct {
		FrameIndex, Layer, Width, Height int
		PTS                              time.Duration
		Recovery                         bool
		DataHex                          string
	}
	var rows []fixtureFrame
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	for {
		var row fixtureFrame
		if err = decoder.Decode(&row); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if row.FrameIndex < 0 || row.FrameIndex >= 40 || len(rows) >= 96 {
			t.Fatal("fixture exceeds the bounded trace")
		}
		rows = append(rows, row)
	}
	if len(rows) != 96 {
		t.Fatal("fixture must contain 96 access units")
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("vp8", 2, 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	for layer, dimensions := range [][2]uint32{{160, 90}, {320, 180}, {640, 360}} {
		if err = source.SetFormat(layer, dimensions[0], dimensions[1]); err != nil {
			t.Fatal(err)
		}
	}
	if err = source.ConfigureOutputs([]uint32{90_000, 300_000, 1_200_000}); err != nil {
		t.Fatal(err)
	}
	a, receiverA, packetsA := connectedReceiver(t, engine, source, "group-a")
	b, receiverB, packetsB := connectedReceiver(t, engine, source, "group-b")
	t.Cleanup(func() { _ = receiverA.Close() })
	t.Cleanup(func() { _ = receiverB.Close() })
	edges := []*Edge{a, b}
	channels := []<-chan *rtp.Packet{packetsA, packetsB}
	// Prove both physical outputs before measuring a trace that cannot answer
	// asynchronous recovery requests. Repeated real keyframes are warmup only.
	warmTicker := time.NewTicker(time.Second / 30)
	defer warmTicker.Stop()
	var warmFrames [2]uint64
	var partial [2]bool
	for frame := 0; frame < 45; frame++ {
		pts := time.Duration(frame+1) * time.Second / 30
		if _, err = source.BeginFrame(pts); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows[:3] {
			if row.FrameIndex != 0 || !row.Recovery {
				t.Fatal("warmup requires the three first-frame recovery outputs")
			}
			data, decodeErr := hex.DecodeString(row.DataHex)
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			if err = source.WriteVideo(row.Layer, encoded.Frame{Data: data, PTS: pts, Duration: time.Second / 30, Recovery: true}); err != nil {
				t.Fatal(err)
			}
		}
		<-warmTicker.C
		for child, channel := range channels {
		drain:
			for {
				select {
				case packet := <-channel:
					if len(packet.Payload) == 0 {
						continue
					}
					partial[child] = !packet.Marker
					if packet.Marker {
						warmFrames[child]++
					}
				default:
					break drain
				}
			}
		}
	}
	var baselineFrames, baselineBytes [2]uint64
	for child, edge := range edges {
		baselineFrames[child], baselineBytes[child], _ = edge.videoCounters()
		if warmFrames[child] == 0 || partial[child] || baselineFrames[child] != warmFrames[child] {
			t.Fatalf("warmup did not drain child %d: received=%d sent=%d partial=%v", child, warmFrames[child], baselineFrames[child], partial[child])
		}
	}
	source.BeginGeneration()
	targets := [][2]int{{2, 2}, {2, 0}, {0, 0}, {1, 1}, {2, 2}}
	type deliveredFrame struct {
		Index, Layer, Width, Height int
		PTS                         time.Duration
		Recovery                    bool
		Data                        []byte
	}
	delivered := [2][]deliveredFrame{}
	var previous [2]*rtp.Packet
	var previousPTS [2]time.Duration
	var payloadBytes [2]uint64
	lastFrame, records := -1, 0
	for _, row := range rows {
		records++
		wanted := targets[row.FrameIndex/8]
		if row.FrameIndex != lastFrame {
			if row.FrameIndex != lastFrame+1 {
				t.Fatal("fixture source frames are not contiguous")
			}
			for child, edge := range edges {
				if err = edge.SetTargetLayer(wanted[child]); err != nil {
					t.Fatal(err)
				}
			}
			highestNeeded := max(wanted[0], wanted[1])
			for _, edge := range edges {
				highestNeeded = max(highestNeeded, int(edge.transport.Output.State().Current))
			}
			plan, err := source.BeginFrame(row.PTS)
			if err != nil || len(plan.Active) != 3 || !plan.Active[wanted[0]] || !plan.Active[wanted[1]] {
				t.Fatalf("requested outputs = %v, active slots = %v, err=%v", wanted, plan.Active, err)
			}
			for slot, active := range plan.Active {
				if active && slot > highestNeeded {
					t.Fatalf("slot %d is active above current/requested output %d", slot, highestNeeded)
				}
			}
			lastFrame = row.FrameIndex
		}
		data, err := hex.DecodeString(row.DataHex)
		if err != nil {
			t.Fatal(err)
		}
		if err = source.WriteVideo(row.Layer, encoded.Frame{
			Data: data, PTS: row.PTS, Duration: time.Second / 30, Recovery: row.Recovery,
		}); err != nil {
			t.Fatal(err)
		}
		for child, layer := range wanted {
			if row.Layer != layer {
				continue
			}
			var received []byte
			var firstTS uint32
			for {
				packet := waitPacket(t, channels[child])
				payloadBytes[child] += uint64(len(packet.Payload))
				if previous[child] != nil && packet.SequenceNumber != previous[child].SequenceNumber+1 {
					t.Fatal("layer switch interrupted outbound RTP sequence")
				}
				if len(received) == 0 {
					firstTS = packet.Timestamp
					if previous[child] != nil {
						delta := packet.Timestamp - previous[child].Timestamp
						want := (row.PTS - previousPTS[child]).Seconds() * videoClockRate
						if float64(delta) < want-1 || float64(delta) > want+1 {
							t.Fatal("layer switch changed source time mapping")
						}
					}
				} else if packet.Timestamp != firstTS {
					t.Fatal("access unit mixed two RTP timestamps")
				}
				payload, parseErr := (&codecs.VP8Packet{}).Unmarshal(packet.Payload)
				if parseErr != nil {
					t.Fatal(parseErr)
				}
				received = append(received, payload...)
				previous[child] = packet
				if packet.Marker {
					break
				}
			}
			if !bytes.Equal(received, data) {
				t.Fatalf("source frame %d child %d selected layer %d: received %d bytes, expected %d; state=%+v",
					row.FrameIndex, child, row.Layer, len(received), len(data), edges[child].transport.Output.State())
			}
			previousPTS[child] = row.PTS
			delivered[child] = append(delivered[child], deliveredFrame{
				Index: row.FrameIndex, Layer: row.Layer, Width: row.Width, Height: row.Height,
				PTS: row.PTS, Recovery: row.Recovery, Data: received,
			})
		}
	}
	if records != 96 || len(delivered[0]) != 40 || len(delivered[1]) != 40 {
		t.Fatalf("input=%d delivered=%d,%d", records, len(delivered[0]), len(delivered[1]))
	}
	for child, edge := range edges {
		frames, bytes, _ := edge.videoCounters()
		if frames-baselineFrames[child] != 40 {
			t.Fatal("sender evidence counted other representations")
		}
		if bytes-baselineBytes[child] != payloadBytes[child] {
			t.Fatal("sender evidence counted unused-layer bytes")
		}
	}
	if outputPath := os.Getenv("SCREENER_ENCODED_OUTPUT"); outputPath != "" {
		data, err := json.Marshal(delivered)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(outputPath, append(data, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Log("96 real VP8 outputs; two unchanged connections delivered 40 selected frames each")
}
