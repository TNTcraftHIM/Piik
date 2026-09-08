package forwarding

import (
	"errors"
	"math"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

// EncodedSource feeds complete codec outputs into the same forwarding buffers
// used for received RTP. Its capture/decoder owner serializes calls and fences
// replacement input; no network, capture or wall-clock scheduler lives here.
type EncodedSource struct {
	*Source
	packetizers []*encoded.Packetizer
	packets     []uint32
	octets      []uint64
	codecBytes  []uint64
	rtpBytes    []uint64
	inputPTS    time.Duration
	anchorPTS   time.Duration
	anchorTime  time.Time
	hasInput    bool
}

func NewEncodedSource(options SourceOptions) (*EncodedSource, error) {
	source, err := NewSource(options)
	if err != nil {
		return nil, err
	}
	input := &EncodedSource{
		Source: source, packetizers: make([]*encoded.Packetizer, len(options.Formats)),
		packets: make([]uint32, len(options.Formats)), octets: make([]uint64, len(options.Formats)),
		codecBytes: make([]uint64, len(options.Formats)), rtpBytes: make([]uint64, len(options.Formats)),
	}
	for layer := range input.packetizers {
		var payloader rtp.Payloader = &codecs.H264Payloader{}
		if options.Codec.MimeType == webrtc.MimeTypeVP8 {
			payloader = &codecs.VP8Payloader{EnablePictureID: true}
		}
		input.packetizers[layer] = encoded.NewPacketizer(payloader, uint8(options.Codec.PayloadType), 1200)
		// These identities stay inside this source's private buffers. DownTrack
		// supplies the independently negotiated wire identity for every child.
		if err = source.BindLayer(layer, uint32(layer+1), webrtc.RTPParameters{
			Codecs: []webrtc.RTPCodecParameters{options.Codec}, HeaderExtensions: options.HeaderExtensions,
		}); err != nil {
			source.Close()
			return nil, err
		}
	}
	return input, nil
}

func (input *EncodedSource) BeginFrame(pts time.Duration, at time.Time) error {
	if input.IsClosed() {
		return errors.New("encoded forwarding source is closed")
	}
	if pts < 0 || at.IsZero() || input.hasInput && pts <= input.inputPTS {
		return encoded.ErrInvalidTimestamp
	}
	if !input.hasInput {
		input.anchorPTS, input.anchorTime = pts, at
	}
	input.hasInput, input.inputPTS = true, pts
	return nil
}

func (input *EncodedSource) WriteFrame(layer int, frame encoded.Frame) error {
	if layer < 0 || layer >= len(input.packetizers) || !input.hasInput ||
		frame.PTS < input.anchorPTS || frame.PTS > input.inputPTS {
		return errors.New("encoded output has no matching source input")
	}
	packets, err := input.packetizers[layer].Packetize(frame.Data, frame.PTS, frame.Duration)
	if err != nil {
		return err
	}
	for _, packet := range packets {
		packet.SSRC = uint32(layer + 1)
		if err = input.Source.WriteRTP(layer, packet); err != nil {
			return err
		}
		input.packets[layer]++
		input.octets[layer] += uint64(len(packet.Payload))
		input.rtpBytes[layer] += uint64(packet.MarshalSize())
	}
	input.codecBytes[layer] += uint64(len(frame.Data))
	// Correlate each layer with the actual input clock, not its encoder finish
	// time. This is internal correlation data, not a backdated wire sender report.
	return input.SetCorrelation(layer, &livekit.RTCPSenderReportState{
		RtpTimestamp: packets[0].Timestamp,
		NtpTimestamp: uint64(mediatransportutil.ToNtpTime(input.anchorTime.Add(frame.PTS - input.anchorPTS))),
		Packets:      input.packets[layer], Octets: input.octets[layer], At: mono.UnixNano(),
	})
}

// CodecBudget converts source-RTP allocation units to encoder AU-payload units.
// Actual packetization includes codec descriptors; bitrate comes from the
// existing tracker window so dormant time does not dilute the overhead rate.
// Downstream extensions and SRTP/UDP overhead are outside this source measure.
func (input *EncodedSource) CodecBudget(layer int, rtpBudget int64) int64 {
	if layer < 0 || layer >= len(input.rtpBytes) || input.rtpBytes[layer] <= input.codecBytes[layer] {
		return max(rtpBudget, 0)
	}
	_, rates := input.GetLayeredBitrate()
	overhead := float64(rates[layer][0]) * float64(input.rtpBytes[layer]-input.codecBytes[layer]) / float64(input.rtpBytes[layer])
	return max(rtpBudget-int64(math.Ceil(overhead)), 0)
}

func (input *EncodedSource) BeginGeneration() {
	// Capture replacement changes the input clock, not these RTP identities.
	// Rebase the packetizers; restarting DownTrack as well would rebase twice.
	for _, packetizer := range input.packetizers {
		packetizer.BeginGeneration()
	}
	input.hasInput = false
	clear(input.codecBytes)
	clear(input.rtpBytes)
}
