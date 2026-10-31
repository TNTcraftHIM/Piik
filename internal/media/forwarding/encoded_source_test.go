package forwarding

import (
	"math"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
	"google.golang.org/protobuf/proto"
)

func TestCodecBudgetUsesActualSourceFraming(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, PayloadType: 96}
	input, err := NewEncodedSource(SourceOptions{ID: "framing", StreamID: "framing", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 100_000}, {Width: 16, Height: 16, Bitrate: 1_000_000}}})
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if input.CodecBudget(0, 120_000) != 120_000 {
		t.Fatal("cold source invented packet overhead")
	}
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	var rates sfu.Bitrates
	for frame := 0; rates[0][0] == 0 || rates[1][0] == 0; frame++ {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("existing screen-share measurement window produced no bitrate")
		}
		pts := time.Duration(frame) * period
		if err = input.BeginFrame(pts, time.Now()); err != nil {
			t.Fatal(err)
		}
		for layer, size := range []int{80, 4000} {
			data := make([]byte, size)
			copy(data, sfu.VP8KeyFrame8x8)
			if err = input.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period}); err != nil {
				t.Fatal(err)
			}
		}
		_, rates = input.GetLayeredBitrate()
	}
	for layer := range input.rtpBytes {
		if input.rtpBytes[layer]-input.codecBytes[layer] <= uint64(input.packets[layer])*12 {
			t.Fatal("codec descriptors were omitted from framing cost")
		}
		overhead := int64(math.Ceil(float64(rates[layer][0]) * float64(input.rtpBytes[layer]-input.codecBytes[layer]) / float64(input.rtpBytes[layer])))
		if got := input.CodecBudget(layer, 120_000); got != max(120_000-overhead, 0) || got >= 120_000 {
			t.Fatalf("layer %d codec budget=%d overhead=%d", layer, got, overhead)
		}
	}
	input.codecBytes[0] = input.rtpBytes[0] + 1 // Annex-B delimiters can be removed by packetization.
	if input.CodecBudget(0, 120_000) != 120_000 {
		t.Fatal("removed codec framing increased the supplied budget")
	}
	input.BeginGeneration()
	if input.CodecBudget(1, 120_000) != 120_000 || input.codecBytes[1] != 0 || input.rtpBytes[1] != 0 {
		t.Fatal("replacement source inherited stale framing ratios")
	}
}

func TestEncodedSourceH264MetadataPreservesCorrelation(t *testing.T) {
	input, err := NewEncodedSource(SourceOptions{ID: "h264-metadata", StreamID: "h264-metadata",
		Codec: webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: 90_000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c01f",
		}, PayloadType: 96}, Formats: []LayerFormat{{Width: 2, Height: 2, Bitrate: 100_000}}})
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	const period = 40 * time.Millisecond
	origin := time.Now()
	write := func(index int, data []byte) {
		t.Helper()
		pts := time.Duration(index) * period
		if err := input.BeginFrame(pts, origin.Add(pts)); err != nil {
			t.Fatal(err)
		}
		if err := input.WriteFrame(0, encoded.Frame{Data: data, PTS: pts, Duration: period}); err != nil {
			t.Fatal(err)
		}
	}
	var keyframe []byte
	for _, nalu := range sfu.H264KeyFrame2x2 {
		keyframe = append(keyframe, 0, 0, 0, 1)
		keyframe = append(keyframe, nalu...)
	}
	write(0, keyframe)
	buffer := input.GetAllBuffers()[0]
	first := buffer.GetSenderReportData()
	if first == nil || input.packets[0] == 0 {
		t.Fatal("first IDR did not establish RTP correlation")
	}
	correlation := proto.Clone(first)
	packets, octets, rtpBytes, codecBytes := input.packets[0], input.octets[0], input.rtpBytes[0], input.codecBytes[0]
	for index, metadata := range [][]byte{
		sfu.H264KeyFrame2x2SPS, sfu.H264KeyFrame2x2PPS,
		{0x09, 0xf0}, {0x0c, 0xff, 0x80}, // AUD and filler produce no RTP.
	} {
		write(index+1, metadata)
		codecBytes += uint64(len(metadata))
		if input.packets[0] != packets || input.octets[0] != octets || input.rtpBytes[0] != rtpBytes {
			t.Fatal("metadata invented RTP packets or cost")
		}
		if input.codecBytes[0] != codecBytes || !proto.Equal(correlation, buffer.GetSenderReportData()) {
			t.Fatal("accepted metadata lost codec bytes or advanced RTP correlation")
		}
	}
	write(5, sfu.H264KeyFrame2x2IDR)
	last := buffer.GetSenderReportData()
	if input.packets[0] != packets+2 || last.RtpTimestamp-first.RtpTimestamp != 18_000 {
		t.Fatal("cached SPS/PPS and the next IDR lost their source RTP timeline")
	}
	if captured, ok := input.ReferenceTime(0, last.RtpTimestamp); !ok || captured.Sub(origin.Add(5*period)).Abs() > time.Microsecond {
		t.Fatal("next IDR correlation used metadata or arrival time")
	}
	packets = input.packets[0]
	write(6, []byte{0x06, 0x05, 0x00, 0x80}) // SEI remains a normal RTP payload.
	if input.packets[0] != packets+1 {
		t.Fatal("SEI was incorrectly treated as packetless metadata")
	}
}
