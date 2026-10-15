package forwarding

import (
	"strconv"
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Each outgoing connection offers one primary video codec and Opus (111).
// RTX keeps late repair outside the primary stream's SRTP replay window.
func registerVideoCodec(media *webrtc.MediaEngine, codec webrtc.RTPCodecParameters) error {
	if err := media.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	repairPayload := webrtc.PayloadType(96)
	if repairPayload == codec.PayloadType {
		repairPayload++
	}
	return media.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX,
			ClockRate: codec.ClockRate, SDPFmtpLine: "apt=" + strconv.Itoa(int(codec.PayloadType))},
		PayloadType: repairPayload,
	}, webrtc.RTPCodecTypeVideo)
}

// ReadRTP restores repaired packets using the negotiated codec. Pion v4.2.23
// can queue RTX before a RID track's first primary read initializes PayloadType,
// even though Codec is already known. Do not rewrite ordinary packets: their
// payload type still has to match the source's negotiated identity.
func ReadRTP(track *webrtc.TrackRemote) (*rtp.Packet, interceptor.Attributes, error) {
	packet, attributes, err := track.ReadRTP()
	if err == nil && attributes.Get(webrtc.AttributeRtxPayloadType) != nil {
		packet.PayloadType = uint8(track.Codec().PayloadType)
	}
	return packet, attributes, err
}

// WithRTX restricts a negotiated offer to one primary codec and its associated
// repair stream. Selecting a media codec must not discard packet-loss recovery.
func WithRTX(primary webrtc.RTPCodecParameters, negotiated []webrtc.RTPCodecParameters) []webrtc.RTPCodecParameters {
	selected := []webrtc.RTPCodecParameters{primary}
	for _, repair := range negotiated {
		if !strings.EqualFold(repair.MimeType, webrtc.MimeTypeRTX) {
			continue
		}
		for _, field := range strings.Split(repair.SDPFmtpLine, ";") {
			key, value, _ := strings.Cut(strings.TrimSpace(field), "=")
			if key == "apt" && strings.TrimSpace(value) == strconv.Itoa(int(primary.PayloadType)) {
				selected = append(selected, repair)
				break
			}
		}
	}
	return selected
}
