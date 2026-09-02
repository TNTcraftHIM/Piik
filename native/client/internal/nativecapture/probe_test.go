package nativecapture

import (
	"strings"
	"testing"
)

const validProbe = `{"protocol":1,"windowsBuild":26200,"windowCapture":true,"processAudio":true,"adapters":[{"index":0,"name":"GPU","luid":"0x0:0x1","hardwareH264":[{"index":0,"name":"H264","clsid":"{encoder}"}]}]}`

func TestDecodeProbeSeparatesCaptureAudioAndHardwareEncode(t *testing.T) {
	capabilities, err := decodeProbe([]byte(validProbe))
	if err != nil {
		t.Fatal(err)
	}
	summary := capabilities.Summary()
	if !summary.WindowVideo || !summary.ProcessAudio || !summary.HardwareH264 {
		t.Fatalf("summary = %+v", summary)
	}
}

func TestDecodeProbeRejectsUnknownTrailingAndDuplicateData(t *testing.T) {
	tests := []string{
		strings.Replace(validProbe, `"protocol":1`, `"protocol":1,"extra":true`, 1),
		validProbe + `{}`,
		strings.Replace(validProbe, `"adapters":[`, `"adapters":[{"index":0,"name":"GPU 2","luid":"0x0:0x2","hardwareH264":[]},`, 1),
	}
	for _, payload := range tests {
		if _, err := decodeProbe([]byte(payload)); err == nil {
			t.Fatalf("invalid probe was accepted: %s", payload)
		}
	}
}

func TestSummaryDoesNotConflateVideoAudioAndEncoder(t *testing.T) {
	capabilities, err := decodeProbe([]byte(
		`{"protocol":1,"windowsBuild":19045,"windowCapture":true,"processAudio":false,"adapters":[{"index":0,"name":"GPU","luid":"0x0:0x1","hardwareH264":[]}]}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	summary := capabilities.Summary()
	if !summary.WindowVideo || summary.ProcessAudio || summary.HardwareH264 {
		t.Fatalf("summary = %+v", summary)
	}
}
