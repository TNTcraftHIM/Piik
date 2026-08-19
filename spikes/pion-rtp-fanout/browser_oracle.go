package fanoutoracle

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	browserOracleWidth       = 320
	browserOracleHeight      = 180
	browserOracleFPS         = 30
	browserOracleFrameCount  = 120
	browserOracleMinDecoded  = 30
	browserOracleMinRendered = 20
	browserOracleMaxBytes    = 8 << 20
)

// BrowserOracleOptions configures the isolated native-to-browser experiment.
// BrowserPath may be empty; in that case RunBrowserOracle searches common
// Chrome, Chromium, and Edge locations.
type BrowserOracleOptions struct {
	BrowserPath string
}

// BrowserOracleResult is the measured output of one pre-encoded VP8 sequence
// sent over two independent standard WebRTC transports.
type BrowserOracleResult struct {
	BrowserUserAgents           [2]string            `json:"browserUserAgents"`
	Fixture                     FixtureMetrics       `json:"fixture"`
	SourceSamples               int                  `json:"sourceSamples"`
	TransportSampleWrites       int                  `json:"transportSampleWrites"`
	Downstream                  [2]BrowserDownstream `json:"downstream"`
	IndependentSSRC             bool                 `json:"independentSsrc"`
	IndependentSequenceSpace    bool                 `json:"independentSequenceSpace"`
	IndependentICECredentials   bool                 `json:"independentIceCredentials"`
	IndependentDTLSFingerprints bool                 `json:"independentDtlsFingerprints"`
	HardStops                   []string             `json:"hardStops"`
}

// FixtureMetrics describes the single WebCodecs fixture encoder instance. Its
// call count is not evidence of a physical or hardware encode.
type FixtureMetrics struct {
	Codec             string `json:"codec"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	FPS               int    `json:"fps"`
	EncoderInputCalls int    `json:"encoderInputCalls"`
	EncodedChunks     int    `json:"encodedChunks"`
	KeyFrames         int    `json:"keyFrames"`
	EncodedBytes      int    `json:"encodedBytes"`
}

// BrowserDownstream records transport-local native and browser observations.
type BrowserDownstream struct {
	ID                int            `json:"id"`
	ConnectionState   string         `json:"connectionState"`
	OfferICEUfrag     string         `json:"offerIceUfrag"`
	AnswerICEUfrag    string         `json:"answerIceUfrag"`
	OfferFingerprint  string         `json:"offerFingerprint"`
	AnswerFingerprint string         `json:"answerFingerprint"`
	RTP               RTPMetrics     `json:"rtp"`
	RTCP              RTCPMetrics    `json:"rtcp"`
	Browser           BrowserMetrics `json:"browser"`
}

// RTPMetrics is observed before per-connection SRTP protection by a public
// Pion interceptor attached to that one PeerConnection.
type RTPMetrics struct {
	SSRC          uint32 `json:"ssrc"`
	FirstSequence uint16 `json:"firstSequence"`
	LastSequence  uint16 `json:"lastSequence"`
	Packets       uint64 `json:"packets"`
	PayloadBytes  uint64 `json:"payloadBytes"`
}

// RTCPMetrics is collected from the independent RTPSender feedback reader.
type RTCPMetrics struct {
	Packets         uint64 `json:"packets"`
	ReceiverReports uint64 `json:"receiverReports"`
	PictureLoss     uint64 `json:"pictureLoss"`
	NACK            uint64 `json:"nack"`
}

// BrowserMetrics comes from the receiver's standard WebRTC stats and actual
// video presentation callbacks.
type BrowserMetrics struct {
	UserAgent              string   `json:"userAgent"`
	PeerConnectionState    string   `json:"peerConnectionState"`
	ICEConnectionState     string   `json:"iceConnectionState"`
	DTLSState              string   `json:"dtlsState"`
	CandidatePairState     string   `json:"candidatePairState"`
	LocalCandidateType     string   `json:"localCandidateType"`
	RemoteCandidateType    string   `json:"remoteCandidateType"`
	InboundSSRC            uint32   `json:"inboundSsrc"`
	PacketsReceived        uint64   `json:"packetsReceived"`
	BytesReceived          uint64   `json:"bytesReceived"`
	FramesReceived         uint64   `json:"framesReceived"`
	FramesDecoded          uint64   `json:"framesDecoded"`
	FramesRendered         uint64   `json:"framesRendered"`
	KeyFramesDecoded       uint64   `json:"keyFramesDecoded"`
	FrameWidth             uint32   `json:"frameWidth"`
	FrameHeight            uint32   `json:"frameHeight"`
	RenderedFrameCallbacks uint64   `json:"renderedFrameCallbacks"`
	RenderedPixelHashes    []uint32 `json:"renderedPixelHashes"`
	DecoderImplementation  string   `json:"decoderImplementation"`
	PowerEfficientDecoder  bool     `json:"powerEfficientDecoder"`
	Error                  string   `json:"error,omitempty"`
}

type fixtureSubmission struct {
	Codec             string         `json:"codec"`
	Width             int            `json:"width"`
	Height            int            `json:"height"`
	FPS               int            `json:"fps"`
	EncoderInputCalls int            `json:"encoderInputCalls"`
	Frames            []encodedFrame `json:"frames"`
}

type encodedFrame struct {
	TimestampMicros int64  `json:"timestampMicros"`
	DurationMicros  int64  `json:"durationMicros"`
	Type            string `json:"type"`
	Data            []byte `json:"data"`
}

type sampleSink interface {
	WriteSample(media.Sample) error
}

// RunBrowserOracle launches a loopback-only fixture generator and two real
// browser receivers, then validates measured decode and presentation evidence.
func RunBrowserOracle(ctx context.Context, options BrowserOracleOptions) (BrowserOracleResult, error) {
	browserPath, err := resolveBrowserPath(options.BrowserPath)
	if err != nil {
		return BrowserOracleResult{}, err
	}

	run, err := newBrowserOracleRun(ctx)
	if err != nil {
		return BrowserOracleResult{}, err
	}
	defer run.close()

	fixtureBrowser, err := launchOracleBrowser(ctx, browserPath, run.fixtureURL(), "fixture")
	if err != nil {
		return BrowserOracleResult{}, err
	}
	defer fixtureBrowser.close()

	fixture, err := run.waitFixture(ctx)
	if err != nil {
		return BrowserOracleResult{}, fmt.Errorf("generate VP8 fixture: %w%s", err, fixtureBrowser.failureSuffix())
	}

	var viewers [2]*oracleBrowserProcess
	for index := range viewers {
		viewers[index], err = launchOracleBrowser(ctx, browserPath, run.viewerURL(index), fmt.Sprintf("viewer-%d", index+1))
		if err != nil {
			return BrowserOracleResult{}, err
		}
		defer viewers[index].close()
	}

	if err = run.waitReady(ctx); err != nil {
		return BrowserOracleResult{}, fmt.Errorf("connect browser receivers: %w%s%s", err, viewers[0].failureSuffix(), viewers[1].failureSuffix())
	}

	// Let both ontrack/play handlers settle after ICE and DTLS connect before
	// the sole keyframe at the head of the sequence is sent.
	settle := time.NewTimer(250 * time.Millisecond)
	select {
	case <-settle.C:
	case <-ctx.Done():
		settle.Stop()
		return BrowserOracleResult{}, ctx.Err()
	}

	sourceSamples, transportWrites, err := fanoutFixture(ctx, fixture.Frames, run.sampleSinks())
	if err != nil {
		return BrowserOracleResult{}, fmt.Errorf("fan out fixture: %w", err)
	}

	browserMetrics, err := run.waitBrowserMetrics(ctx)
	if err != nil {
		return BrowserOracleResult{}, fmt.Errorf("wait for browser decode/render evidence: %w%s%s", err, viewers[0].failureSuffix(), viewers[1].failureSuffix())
	}

	result := run.result(fixture, browserMetrics, sourceSamples, transportWrites)
	if err = validateBrowserOracleResult(result); err != nil {
		return BrowserOracleResult{}, err
	}

	return result, nil
}

func fanoutFixture(ctx context.Context, frames []encodedFrame, sinks []sampleSink) (int, int, error) {
	if len(sinks) != 2 {
		return 0, 0, fmt.Errorf("sink count = %d, want 2", len(sinks))
	}

	start := time.Now()
	elapsed := time.Duration(0)
	transportWrites := 0
	for index, frame := range frames {
		if index > 0 {
			timer := time.NewTimer(time.Until(start.Add(elapsed)))
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return index, transportWrites, ctx.Err()
			}
		}

		duration := time.Duration(frame.DurationMicros) * time.Microsecond
		sample := media.Sample{Data: frame.Data, Duration: duration}
		for sinkIndex, sink := range sinks {
			if err := sink.WriteSample(sample); err != nil {
				return index + 1, transportWrites, fmt.Errorf("write source sample %d to transport %d: %w", index, sinkIndex+1, err)
			}
			transportWrites++
		}
		elapsed += duration
	}

	return len(frames), transportWrites, nil
}

func validateFixture(fixture fixtureSubmission) error {
	if fixture.Codec != "vp8" {
		return fmt.Errorf("fixture codec = %q, want vp8", fixture.Codec)
	}
	if fixture.Width != browserOracleWidth || fixture.Height != browserOracleHeight || fixture.FPS != browserOracleFPS {
		return fmt.Errorf("fixture format = %dx%d@%d, want %dx%d@%d", fixture.Width, fixture.Height, fixture.FPS, browserOracleWidth, browserOracleHeight, browserOracleFPS)
	}
	if len(fixture.Frames) != browserOracleFrameCount || fixture.EncoderInputCalls != len(fixture.Frames) {
		return fmt.Errorf("fixture inputs/chunks = %d/%d, want %d/%d", fixture.EncoderInputCalls, len(fixture.Frames), browserOracleFrameCount, browserOracleFrameCount)
	}
	if fixture.Frames[0].Type != "key" {
		return errors.New("fixture does not start with a VP8 key frame")
	}

	totalBytes := 0
	keyFrames := 0
	previousTimestamp := int64(-1)
	for index, frame := range fixture.Frames {
		if len(frame.Data) == 0 {
			return fmt.Errorf("fixture frame %d is empty", index)
		}
		if frame.TimestampMicros <= previousTimestamp {
			return fmt.Errorf("fixture frame %d timestamp is not increasing", index)
		}
		if frame.DurationMicros <= 0 || frame.DurationMicros > int64(time.Second/time.Microsecond) {
			return fmt.Errorf("fixture frame %d duration is invalid", index)
		}
		if frame.Type != "key" && frame.Type != "delta" {
			return fmt.Errorf("fixture frame %d type = %q", index, frame.Type)
		}
		if frame.Type == "key" {
			keyFrames++
		}
		previousTimestamp = frame.TimestampMicros
		totalBytes += len(frame.Data)
		if totalBytes > browserOracleMaxBytes {
			return errors.New("fixture exceeds 8 MiB limit")
		}
	}
	if keyFrames < 2 {
		return errors.New("fixture needs at least two periodic key frames")
	}

	return nil
}

func fixtureMetrics(fixture fixtureSubmission) FixtureMetrics {
	metrics := FixtureMetrics{
		Codec:             fixture.Codec,
		Width:             fixture.Width,
		Height:            fixture.Height,
		FPS:               fixture.FPS,
		EncoderInputCalls: fixture.EncoderInputCalls,
		EncodedChunks:     len(fixture.Frames),
	}
	for _, frame := range fixture.Frames {
		metrics.EncodedBytes += len(frame.Data)
		if frame.Type == "key" {
			metrics.KeyFrames++
		}
	}
	return metrics
}

func validateBrowserOracleResult(result BrowserOracleResult) error {
	if result.SourceSamples != result.Fixture.EncodedChunks {
		return fmt.Errorf("source samples = %d, encoded chunks = %d", result.SourceSamples, result.Fixture.EncodedChunks)
	}
	if result.TransportSampleWrites != result.SourceSamples*2 {
		return fmt.Errorf("transport writes = %d, want %d", result.TransportSampleWrites, result.SourceSamples*2)
	}
	if !result.IndependentSSRC || !result.IndependentSequenceSpace || !result.IndependentICECredentials || !result.IndependentDTLSFingerprints {
		return errors.New("the two browser legs did not retain independent RTP/ICE/DTLS transport identity")
	}

	for index, downstream := range result.Downstream {
		if downstream.ConnectionState != "connected" {
			return fmt.Errorf("downstream %d native state = %q", index+1, downstream.ConnectionState)
		}
		if downstream.RTP.Packets == 0 || downstream.RTP.PayloadBytes == 0 {
			return fmt.Errorf("downstream %d has no observed RTP payload", index+1)
		}
		if downstream.RTCP.Packets == 0 || downstream.RTCP.ReceiverReports == 0 {
			return fmt.Errorf("downstream %d has no independent RTCP receiver report", index+1)
		}
		browser := downstream.Browser
		if browser.Error != "" {
			return fmt.Errorf("downstream %d browser error: %s", index+1, browser.Error)
		}
		if browser.PeerConnectionState != "connected" || browser.DTLSState != "connected" || browser.CandidatePairState != "succeeded" {
			return fmt.Errorf("downstream %d browser transport is not connected", index+1)
		}
		if browser.InboundSSRC != downstream.RTP.SSRC {
			return fmt.Errorf("downstream %d browser SSRC %d differs from native SSRC %d", index+1, browser.InboundSSRC, downstream.RTP.SSRC)
		}
		if browser.PacketsReceived == 0 || browser.BytesReceived == 0 || browser.FramesDecoded < browserOracleMinDecoded {
			return fmt.Errorf("downstream %d decoded only %d frames", index+1, browser.FramesDecoded)
		}
		if browser.RenderedFrameCallbacks < browserOracleMinRendered || uniqueUint32(browser.RenderedPixelHashes) < 2 {
			return fmt.Errorf("downstream %d lacks changing rendered-frame evidence", index+1)
		}
		if browser.FrameWidth != browserOracleWidth || browser.FrameHeight != browserOracleHeight {
			return fmt.Errorf("downstream %d decoded dimensions = %dx%d", index+1, browser.FrameWidth, browser.FrameHeight)
		}
	}

	return nil
}

func uniqueUint32(values []uint32) int {
	seen := make(map[uint32]struct{}, len(values))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	return len(seen)
}
