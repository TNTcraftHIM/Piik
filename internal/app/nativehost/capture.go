package nativehost

import (
	"context"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

// CaptureStream is owned by one installed capture generation. Android supplies
// frames in-process; desktop capture retains its supervised process adapter.
type CaptureStream interface {
	Read() (nativecapture.Frame, error)
	Close() error
	Outputs() []nativecapture.OutputProfile
	RequestKeyFrame(int) error
	SetOutputActive(int, bool) error
	SetOutputBitrate(int, uint32) error
}

type CaptureProvider interface {
	Video(context.Context, nativecapture.VideoOptions) (CaptureStream, error)
	Audio(context.Context, nativecapture.CaptureTarget, *nativecapture.CaptureTarget) (CaptureStream, error)
	Microphone(context.Context, string) (CaptureStream, error)
}

type processCapture struct{ executable string }

func (p processCapture) Video(ctx context.Context, options nativecapture.VideoOptions) (CaptureStream, error) {
	stream, err := nativecapture.StartVideo(ctx, p.executable, options)
	if err != nil {
		return nil, err
	}
	return stream, nil
}
func (p processCapture) Audio(ctx context.Context, target nativecapture.CaptureTarget, exclude *nativecapture.CaptureTarget) (CaptureStream, error) {
	stream, err := startAudioCapture(ctx, p.executable, target, exclude)
	if err != nil {
		return nil, err
	}
	return stream, nil
}
func (p processCapture) Microphone(ctx context.Context, device string) (CaptureStream, error) {
	stream, err := nativecapture.StartMicrophone(ctx, p.executable, device)
	if err != nil {
		return nil, err
	}
	return stream, nil
}
