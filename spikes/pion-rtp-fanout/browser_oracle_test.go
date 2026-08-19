package fanoutoracle

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

type recordingSampleSink struct {
	samples []media.Sample
	err     error
}

func (sink *recordingSampleSink) WriteSample(sample media.Sample) error {
	if sink.err != nil {
		return sink.err
	}
	sink.samples = append(sink.samples, media.Sample{
		Data:     append([]byte(nil), sample.Data...),
		Duration: sample.Duration,
	})
	return nil
}

func TestFanoutFixtureReadsEachSourceSampleOnceAndWritesBothTransports(t *testing.T) {
	frames := []encodedFrame{
		{TimestampMicros: 0, DurationMicros: 1, Type: "key", Data: []byte{1, 2, 3}},
		{TimestampMicros: 1, DurationMicros: 1, Type: "delta", Data: []byte{4, 5}},
	}
	first := &recordingSampleSink{}
	second := &recordingSampleSink{}

	sourceSamples, writes, err := fanoutFixture(context.Background(), frames, []sampleSink{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if sourceSamples != len(frames) || writes != len(frames)*2 {
		t.Fatalf("source samples/writes = %d/%d", sourceSamples, writes)
	}
	for index, frame := range frames {
		if !bytes.Equal(first.samples[index].Data, frame.Data) || !bytes.Equal(second.samples[index].Data, frame.Data) {
			t.Fatalf("sample %d payload differs between source and transports", index)
		}
	}
}

func TestFanoutFixtureReportsOneTransportFailure(t *testing.T) {
	want := errors.New("transport stopped")
	_, writes, err := fanoutFixture(context.Background(), []encodedFrame{{DurationMicros: 1, Data: []byte{1}}}, []sampleSink{
		&recordingSampleSink{},
		&recordingSampleSink{err: want},
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
	if writes != 1 {
		t.Fatalf("successful writes = %d, want 1", writes)
	}
}

func TestValidateFixtureRejectsNonKeyframeStart(t *testing.T) {
	fixture := validFixtureSubmission()
	fixture.Frames[0].Type = "delta"
	if err := validateFixture(fixture); err == nil {
		t.Fatal("expected a non-keyframe fixture to be rejected")
	}
}

func TestValidateBrowserOracleResultRequiresIndependentTransportIdentity(t *testing.T) {
	result := validBrowserOracleResult()
	result.IndependentSequenceSpace = false
	if err := validateBrowserOracleResult(result); err == nil {
		t.Fatal("expected shared sequence identity to be rejected")
	}
}

func TestValidateBrowserOracleResultAcceptsDecodedAndRenderedEvidence(t *testing.T) {
	if err := validateBrowserOracleResult(validBrowserOracleResult()); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserOracleWithRealChromium(t *testing.T) {
	if os.Getenv("SCREENER_RUN_BROWSER_ORACLE") != "1" {
		t.Skip("set SCREENER_RUN_BROWSER_ORACLE=1 to launch two real browser receivers")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if _, err := RunBrowserOracle(ctx, BrowserOracleOptions{}); err != nil {
		t.Fatal(err)
	}
}

func validFixtureSubmission() fixtureSubmission {
	frames := make([]encodedFrame, browserOracleFrameCount)
	for index := range frames {
		frameType := "delta"
		if index%30 == 0 {
			frameType = "key"
		}
		frames[index] = encodedFrame{
			TimestampMicros: int64(index) * 33333,
			DurationMicros:  33333,
			Type:            frameType,
			Data:            []byte{byte(index + 1)},
		}
	}
	return fixtureSubmission{
		Codec:             "vp8",
		Width:             browserOracleWidth,
		Height:            browserOracleHeight,
		FPS:               browserOracleFPS,
		EncoderInputCalls: browserOracleFrameCount,
		Frames:            frames,
	}
}

func validBrowserOracleResult() BrowserOracleResult {
	result := BrowserOracleResult{
		Fixture: FixtureMetrics{
			Codec:             "vp8",
			Width:             browserOracleWidth,
			Height:            browserOracleHeight,
			FPS:               browserOracleFPS,
			EncoderInputCalls: browserOracleFrameCount,
			EncodedChunks:     browserOracleFrameCount,
		},
		SourceSamples:               browserOracleFrameCount,
		TransportSampleWrites:       browserOracleFrameCount * 2,
		IndependentSSRC:             true,
		IndependentSequenceSpace:    true,
		IndependentICECredentials:   true,
		IndependentDTLSFingerprints: true,
	}
	for index := 0; index < 2; index++ {
		result.Downstream[index] = BrowserDownstream{
			ConnectionState: "connected",
			RTP: RTPMetrics{
				SSRC:         uint32(index + 1),
				Packets:      100,
				PayloadBytes: 1000,
			},
			RTCP: RTCPMetrics{Packets: 1, ReceiverReports: 1},
			Browser: BrowserMetrics{
				PeerConnectionState:    "connected",
				DTLSState:              "connected",
				CandidatePairState:     "succeeded",
				InboundSSRC:            uint32(index + 1),
				PacketsReceived:        100,
				BytesReceived:          1000,
				FramesDecoded:          browserOracleMinDecoded,
				FrameWidth:             browserOracleWidth,
				FrameHeight:            browserOracleHeight,
				RenderedFrameCallbacks: browserOracleMinRendered,
				RenderedPixelHashes:    []uint32{1, 2},
			},
		}
	}
	return result
}
