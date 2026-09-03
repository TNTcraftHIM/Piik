package nativehost

import "testing"

func TestCaptureStateKeepsStartingAndActiveContractsDistinct(t *testing.T) {
	starting, err := decodeCaptureState([]byte(
		`{"state":"starting","hardwareOnly":true,"adapterIndex":0,"adapterName":"GPU","adapterIdentity":"0:1","encoderIndex":0,"encoderName":"H264","encoderIdentity":"encoder"}`,
	))
	if err != nil || starting.State != "starting" || starting.AdapterIndex == nil {
		t.Fatalf("starting = %+v, %v", starting, err)
	}
	active, err := decodeCaptureState([]byte(
		`{"state":"active","hardwareOnly":true,"profileLevelId":"42c01f","width":1280,"height":720,"fps":30}`,
	))
	if err != nil || active.State != "active" || active.ProfileLevelID != "42c01f" {
		t.Fatalf("active = %+v, %v", active, err)
	}
}

func TestCaptureStateRejectsUnknownOrUnattributedState(t *testing.T) {
	for _, payload := range []string{
		`{"state":"active","hardwareOnly":false}`,
		`{"state":"ready","hardwareOnly":true}`,
		`{"state":"active","hardwareOnly":true,"extra":true}`,
	} {
		if _, err := decodeCaptureState([]byte(payload)); err == nil {
			t.Fatalf("invalid state was accepted: %s", payload)
		}
	}
}
