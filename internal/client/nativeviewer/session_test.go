package nativeviewer

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/client/nativecapture"
)

func TestViewerProfileHasNoImplicitCaptureDefault(t *testing.T) {
	session := &Session{}
	if session.profile != nil || session.UpdateProfile(nativecapture.VideoProfile{}) == nil {
		t.Fatal("receive-only Viewer acquired an implicit or invalid profile")
	}
	profile := nativecapture.VideoProfile{
		Width: 1920, Height: 1080, Framerate: 30, Bitrate: 5_000_000, Preference: "balanced",
	}
	if err := session.UpdateProfile(profile); err != nil || session.profile == nil || *session.profile != profile {
		t.Fatalf("explicit Viewer profile = %v, %v", session.profile, err)
	}
	previous := session.profile
	if err := session.UpdateProfile(profile); err != nil || session.profile != previous {
		t.Fatal("unchanged ceiling created another profile update")
	}
	session.closed = true
	if session.UpdateProfile(profile) == nil {
		t.Fatal("closed Viewer accepted a profile")
	}
}
