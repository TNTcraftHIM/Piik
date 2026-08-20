package remote

import (
	"fmt"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/media"
	"github.com/pion/webrtc/v4"
)

const (
	h264PayloadType    = 114
	h264RTXPayloadType = 115
)

// newPeerAPI keeps the default VP8 API untouched. H.264 gets a private
// MediaEngine so its fixture-derived profile is advertised only on opt-in
// sessions and cannot alter Web or ordinary Native negotiation.
func newPeerAPI(codec media.Codec) (*webrtc.API, []webrtc.RTPCodecParameters, error) {
	if codec == media.CodecVP8 {
		return nil, nil, nil
	}
	if codec != media.CodecH264 {
		return nil, nil, fmt.Errorf("unsupported native codec %q", codec)
	}

	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		return nil, nil, fmt.Errorf("register default codecs: %w", err)
	}
	feedback := []webrtc.RTCPFeedback{
		{Type: "ccm", Parameter: "fir"},
		{Type: "nack"},
		{Type: "nack", Parameter: "pli"},
	}
	primary := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: 90_000,
			SDPFmtpLine: media.H264SDPFmtpLine, RTCPFeedback: feedback,
		},
		PayloadType: h264PayloadType,
	}
	rtx := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeRTX, ClockRate: 90_000,
			SDPFmtpLine: fmt.Sprintf("apt=%d", h264PayloadType),
		},
		PayloadType: h264RTXPayloadType,
	}
	if err := engine.RegisterCodec(primary, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, fmt.Errorf("register H.264 codec: %w", err)
	}
	if err := engine.RegisterCodec(rtx, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, fmt.Errorf("register H.264 RTX codec: %w", err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(engine)), []webrtc.RTPCodecParameters{primary, rtx}, nil
}
