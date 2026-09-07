package mediaedge

import (
	"bytes"
	"errors"
	"io"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	mediacodec "github.com/livekit/mediatransportutil/pkg/codec"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

// Decoder configuration belongs to this received stream, not a child encoder.
type relayVideoInput struct {
	codec  string
	sps    []byte
	pps    []byte
	width  uint32
	height uint32
}

func (input *relayVideoInput) frame(data []byte) (nativecapture.Frame, error) {
	frame := nativecapture.Frame{Data: data}
	if input.codec == "vp8" {
		frame.Kind = nativecapture.FrameVP8
		frame.KeyFrame = len(data) >= 10 && data[0]&1 == 0
		size := mediacodec.ExtractVP8VideoSize(&mediacodec.VP8{IsKeyFrame: frame.KeyFrame}, data)
		if size.Width > 0 && size.Height > 0 {
			input.width, input.height = size.Width, size.Height
		}
	} else {
		frame.Kind = nativecapture.FrameH264
		reader, err := h264reader.NewReader(bytes.NewReader(data))
		if err != nil {
			return frame, err
		}
		for {
			nal, err := reader.NextNAL()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return frame, err
			}
			switch nal.UnitType {
			case h264reader.NalUnitTypeSPS:
				input.sps = append(input.sps[:0], nal.Data...)
				size := mediacodec.ExtractH264VideoSize(nal.Data)
				if size.Width > 0 && size.Height > 0 {
					input.width, input.height = size.Width, size.Height
				}
			case h264reader.NalUnitTypePPS:
				input.pps = append(input.pps[:0], nal.Data...)
			case h264reader.NalUnitTypeCodedSliceIdr:
				frame.KeyFrame = true
			}
		}
		if frame.KeyFrame {
			frame.KeyFrame = len(input.sps) > 0 && len(input.pps) > 0
			if frame.KeyFrame {
				// Browser senders can put parameter sets in an earlier access unit.
				prefix := make([]byte, 0, len(input.sps)+len(input.pps)+len(data)+8)
				for _, nal := range [][]byte{input.sps, input.pps} {
					prefix = append(prefix, 0, 0, 0, 1)
					prefix = append(prefix, nal...)
				}
				frame.Data = append(prefix, data...)
			}
		}
	}
	frame.Width, frame.Height = input.width, input.height
	return frame, nil
}
