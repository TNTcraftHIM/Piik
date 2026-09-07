package mediaedge

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

func TestRelayInputKeepsRecoveryAndEmitsACompleteQuietFrame(t *testing.T) {
	// A single complete access unit must not need a subsequent frame or timer.
	key, err := hex.DecodeString("1000009d012aa0005a00")
	if err != nil {
		t.Fatal(err)
	}
	builder := samplebuilder.New(relayPacketLimit, &codecs.VP8Packet{}, videoClockRate)
	builder.Push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 10, Timestamp: 0xfffffff0, Marker: true},
		Payload: append([]byte{0x10}, key...)})
	sample, timestamp := builder.PopWithTimestamp()
	if sample == nil || timestamp != 0xfffffff0 || !bytes.Equal(sample.Data, key) {
		t.Fatal("complete quiet frame waited for future input")
	}
	input := relayVideoInput{codec: "vp8"}
	frame, err := input.frame(sample.Data)
	if err != nil || !frame.KeyFrame || frame.Width != 160 || frame.Height != 90 {
		t.Fatalf("VP8 recovery metadata = %+v, %v", frame, err)
	}
	frame, err = input.frame([]byte{1, 0, 0, 1})
	if err != nil || frame.KeyFrame || frame.Width != 160 || frame.Height != 90 {
		t.Fatal("delta frame lost the stream's dimensions")
	}

	input = relayVideoInput{codec: "h264"}
	configuration, _ := hex.DecodeString("000000016742c01eda0280b7fe5c050505020000000168ce06e2")
	if _, err = input.frame(configuration); err != nil {
		t.Fatal(err)
	}
	frame, err = input.frame([]byte{0, 0, 0, 1, 0x65, 0x88, 0x84})
	if err != nil || !frame.KeyFrame || !bytes.Contains(frame.Data, configuration[:4+len(input.sps)]) ||
		!bytes.Contains(frame.Data, input.pps) {
		t.Fatal("H264 IDR lost preceding decoder configuration")
	}
}
