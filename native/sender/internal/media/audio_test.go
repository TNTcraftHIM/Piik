package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestAudioFanoutUsesOneOpusTimeline(t *testing.T) {
	written := make(chan *rtp.Packet, 2)
	fanout := newAudioFanout(nil, rtpWriterFunc(func(packet *rtp.Packet) error {
		written <- packet.Clone()
		return nil
	}), nil)
	defer fanout.Close()

	for _, timestamp := range []uint64{100_000, 300_000} {
		if err := fanout.Push(Packet{
			Kind: KindOpus, Timestamp100ns: timestamp, Duration100ns: 200_000,
			Data: []byte{0xf8, 0xff, 0xfe},
		}); err != nil {
			t.Fatal(err)
		}
	}
	first := awaitAudioPacket(t, written)
	second := awaitAudioPacket(t, written)
	if delta := second.Timestamp - first.Timestamp; delta != 960 {
		t.Fatalf("Opus RTP timestamp delta = %d, want 960", delta)
	}
}

func TestOpusTrackCapabilityIsBrowserCompatible(t *testing.T) {
	fanout, err := NewAudioFanout(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer fanout.Close()
	codec := fanout.Track().Codec()
	if codec.MimeType != webrtc.MimeTypeOpus || codec.ClockRate != 48_000 || codec.Channels != 2 ||
		codec.SDPFmtpLine != OpusSDPFmtpLine {
		t.Fatalf("Opus capability = %+v", codec)
	}
}

func awaitAudioPacket(t *testing.T, packets <-chan *rtp.Packet) *rtp.Packet {
	t.Helper()
	select {
	case packet := <-packets:
		return packet
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for shared Opus RTP")
		return nil
	}
}
