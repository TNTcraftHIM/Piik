package nativecontrol

import (
	"context"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativehost"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
)

// CaptureProvider supplies the platform capture operations used by the control
// session. The control protocol and media routing do not depend on its runtime.
type CaptureProvider interface {
	nativehost.CaptureProvider
	sourceProvider
}

type sourceProvider interface {
	ListSources(context.Context) ([]nativecapture.CaptureTarget, error)
	PreviewSource(context.Context, nativecapture.CaptureTarget) ([]byte, error)
	ListMicrophones(context.Context) ([]nativecapture.Microphone, error)
}

type processSources struct{ executable string }

func (p processSources) ListSources(ctx context.Context) ([]nativecapture.CaptureTarget, error) {
	return nativecapture.ListSources(ctx, p.executable)
}

func (p processSources) PreviewSource(ctx context.Context, target nativecapture.CaptureTarget) ([]byte, error) {
	return nativecapture.PreviewSource(ctx, p.executable, target)
}

func (p processSources) ListMicrophones(ctx context.Context) ([]nativecapture.Microphone, error) {
	return nativecapture.ListMicrophones(ctx, p.executable)
}

// NewWithCapture uses an in-process platform producer instead of the desktop
// capture executable. Capabilities still describe actual platform support.
func NewWithCapture(
	capabilities nativecapture.Capabilities,
	portMapping bool,
	remoteInput *remoteinput.Manager,
	capture CaptureProvider,
) *Session {
	return newSession("", capabilities, portMapping, remoteInput, capture, capture)
}
