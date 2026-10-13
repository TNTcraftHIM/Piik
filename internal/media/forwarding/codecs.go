package forwarding

import (
	"strconv"
	"strings"

	"github.com/pion/webrtc/v4"
)

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
