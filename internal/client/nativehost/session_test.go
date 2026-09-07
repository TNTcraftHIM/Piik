package nativehost

import (
	"encoding/json"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
)

func TestCaptureStateKeepsStartingAndActiveContractsDistinct(t *testing.T) {
	starting, err := decodeCaptureState(captureStatePayload(t,
		`{"state":"starting","hardwareOnly":true,"codec":"h264","adapterIndex":0,"adapterName":"GPU","adapterIdentity":"0:1","encoderIndex":0,"encoderName":"H264","encoderIdentity":"encoder"}`,
	))
	if err != nil || starting.State != "starting" || starting.AdapterIndex == nil {
		t.Fatalf("starting = %+v, %v", starting, err)
	}
	active, err := decodeCaptureState(captureStatePayload(t,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c01f","width":1280,"height":720,"fps":30}`,
	))
	if err != nil || active.State != "active" || active.ProfileLevelID != "42c01f" {
		t.Fatalf("active = %+v, %v", active, err)
	}
	for _, payload := range []string{
		`{"state":"starting","hardwareOnly":false,"codec":"vp8","adapterIndex":0,"adapterName":"GPU","adapterIdentity":"0:1","encoderName":"libvpx VP8","encoderIdentity":"libvpx/v1.17.0"}`,
		`{"state":"active","hardwareOnly":false,"codec":"vp8","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c01e","width":854,"height":480,"fps":15}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c033","width":2560,"height":1440,"fps":60,"restoreToken":"portal-token"}`,
	} {
		if _, err = decodeCaptureState(captureStatePayload(t, payload)); err != nil {
			t.Fatalf("valid profile state was rejected: %s: %v", payload, err)
		}
	}
}

func TestCaptureStateRejectsUnknownOrUnattributedState(t *testing.T) {
	for _, payload := range []string{
		`{"state":"active","hardwareOnly":true,"codec":"vp8","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":false,"codec":"vp8","profileLevelId":"42c01f","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":false}`,
		`{"state":"ready","hardwareOnly":true}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","extra":true}`,
	} {
		if _, err := decodeCaptureState(captureStatePayload(t, payload)); err == nil {
			t.Fatalf("invalid state was accepted: %s", payload)
		}
	}
}

func captureStatePayload(t *testing.T, payload string) []byte {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &fields); err != nil {
		t.Fatal(err)
	}
	profile := nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 3_000_000}
	for key, field := range map[string]*uint32{"width": &profile.Width, "height": &profile.Height, "fps": &profile.Framerate} {
		if value, ok := fields[key]; ok {
			if err := json.Unmarshal(value, field); err != nil {
				t.Fatal(err)
			}
		}
	}
	outputs, err := json.Marshal(nativecapture.ScreenShareOutputs(profile))
	if err != nil {
		t.Fatal(err)
	}
	fields["outputs"] = outputs
	result, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCandidateForRetiredEdgeIsIgnored(t *testing.T) {
	session := &Session{}
	if err := session.AddCandidate("retired-edge", nil); err != nil {
		t.Fatalf("stale candidate stopped the session: %v", err)
	}
}
