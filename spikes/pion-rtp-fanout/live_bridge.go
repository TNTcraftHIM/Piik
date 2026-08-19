package fanoutoracle

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	liveBridgeWidth                    = 320
	liveBridgeHeight                   = 180
	liveBridgeFPS                      = 30
	liveBridgeFrameCount               = 360
	liveBridgeInitialBitrate           = 600_000
	liveBridgeQueueCapacity            = 8
	liveBridgeMinDecoded               = 240
	liveBridgeMinRendered              = 200
	liveBridgeMinDuration              = 10 * time.Second
	liveBridgeMaxDuration              = 25 * time.Second
	liveBridgeSocketBufferLimit        = 512 << 10
	liveBridgeEncoderQueueLimit        = 4
	liveBridgeMaxChunkBytes            = 1 << 20
	liveBridgeMaxStreamBytes           = 32 << 20
	liveBridgeMaxReceivedChunks        = 750
	liveBridgeTokenBytes               = 32
	liveBridgeHardwareAccelerationHint = "no-preference"
	liveFeedbackWidth                  = 1280
	liveFeedbackHeight                 = 720
	liveFeedbackFrameCount             = 390
	liveFeedbackInitialBitrate         = 1_200_000
	liveFeedbackMinDecoded             = 300
	liveFeedbackMinRendered            = 280
	liveFeedbackMinDuration            = 12 * time.Second
)

type liveBridgeProfile struct {
	Width          int           `json:"width"`
	Height         int           `json:"height"`
	FPS            int           `json:"fps"`
	FrameCount     int           `json:"frameCount"`
	InitialBitrate int           `json:"initialBitrate"`
	FeedbackLoop   bool          `json:"feedbackLoop"`
	MinDecoded     int           `json:"-"`
	MinRendered    int           `json:"-"`
	MinDuration    time.Duration `json:"-"`
}

func defaultLiveBridgeProfile() liveBridgeProfile {
	return liveBridgeProfile{
		Width:          liveBridgeWidth,
		Height:         liveBridgeHeight,
		FPS:            liveBridgeFPS,
		FrameCount:     liveBridgeFrameCount,
		InitialBitrate: liveBridgeInitialBitrate,
		MinDecoded:     liveBridgeMinDecoded,
		MinRendered:    liveBridgeMinRendered,
		MinDuration:    liveBridgeMinDuration,
	}
}

func liveFeedbackBridgeProfile() liveBridgeProfile {
	return liveBridgeProfile{
		Width:          liveFeedbackWidth,
		Height:         liveFeedbackHeight,
		FPS:            liveBridgeFPS,
		FrameCount:     liveFeedbackFrameCount,
		InitialBitrate: liveFeedbackInitialBitrate,
		FeedbackLoop:   true,
		MinDecoded:     liveFeedbackMinDecoded,
		MinRendered:    liveFeedbackMinRendered,
		MinDuration:    liveFeedbackMinDuration,
	}
}

// LiveBridgeOptions configures the isolated browser-to-native-to-browser run.
type LiveBridgeOptions struct {
	BrowserPath string
}

// LiveBridgeResult records one continuous WebCodecs encoder feeding two
// independent Pion transports through an authenticated loopback IPC bridge.
type LiveBridgeResult struct {
	Host                         LiveBridgeHostMetrics             `json:"host"`
	IPC                          LiveBridgeIPCMetrics              `json:"ipc"`
	Queue                        LiveQueueMetrics                  `json:"queue"`
	SourceSamples                int                               `json:"sourceSamples"`
	TransportSampleWrites        int                               `json:"transportSampleWrites"`
	Downstream                   [2]BrowserDownstream              `json:"downstream"`
	IndependentSSRC              bool                              `json:"independentSsrc"`
	IndependentSequenceSpace     bool                              `json:"independentSequenceSpace"`
	IndependentICECredentials    bool                              `json:"independentIceCredentials"`
	IndependentDTLSFingerprints  bool                              `json:"independentDtlsFingerprints"`
	EqualEdgePayloadBytes        bool                              `json:"equalEdgePayloadBytes"`
	PhysicalHardwareEncodeProven bool                              `json:"physicalHardwareEncodeProven"`
	PrimaryRetransmission        *PrimaryRetransmissionGateMetrics `json:"primaryRetransmission,omitempty"`
	FeedbackLoop                 *LiveFeedbackLoopMetrics          `json:"feedbackLoop,omitempty"`
	HardStops                    []string                          `json:"hardStops"`
}

// LiveBridgeHostMetrics are reported by the real Chrome host page. The
// hardwareAcceleration value is only the WebCodecs configuration hint.
type LiveBridgeHostMetrics struct {
	UserAgent                 string   `json:"userAgent"`
	EncoderInstances          int      `json:"encoderInstances"`
	EncoderInputCalls         int      `json:"encoderInputCalls"`
	EncoderOutputs            int      `json:"encoderOutputs"`
	SentChunks                int      `json:"sentChunks"`
	KeyFrames                 int      `json:"keyFrames"`
	EncoderOutputBytes        int      `json:"encoderOutputBytes"`
	SentChunkBytes            int      `json:"sentChunkBytes"`
	EncoderInputDrops         int      `json:"encoderInputDrops"`
	SocketDroppedChunks       int      `json:"socketDroppedChunks"`
	MaxEncoderQueueSize       int      `json:"maxEncoderQueueSize"`
	MaxSocketBufferedBytes    int      `json:"maxSocketBufferedBytes"`
	SocketBufferedBytesLimit  int      `json:"socketBufferedBytesLimit"`
	EncoderQueueLimit         int      `json:"encoderQueueLimit"`
	HardwareAccelerationHint  string   `json:"hardwareAccelerationHint"`
	ElapsedMillis             int64    `json:"elapsedMillis"`
	InitialBitrate            int      `json:"initialBitrate"`
	EncoderConfigureCalls     int      `json:"encoderConfigureCalls"`
	TargetApplications        int      `json:"targetApplications"`
	AppliedTargetBitrates     []int    `json:"appliedTargetBitrates"`
	AppliedTargetGenerations  []uint64 `json:"appliedTargetGenerations"`
	EncoderInputsAfterTarget  int      `json:"encoderInputsAfterTarget"`
	EncoderOutputsAfterTarget int      `json:"encoderOutputsAfterTarget"`
}

// LiveBridgeIPCMetrics are measured by the native helper, not inferred from
// browser counters.
type LiveBridgeIPCMetrics struct {
	Transport                string `json:"transport"`
	BindAddress              string `json:"bindAddress"`
	LoopbackOnly             bool   `json:"loopbackOnly"`
	OriginValidated          bool   `json:"originValidated"`
	StartupTokenBytes        int    `json:"startupTokenBytes"`
	Codec                    string `json:"codec"`
	Width                    int    `json:"width"`
	Height                   int    `json:"height"`
	FPS                      int    `json:"fps"`
	HardwareAccelerationHint string `json:"hardwareAccelerationHint"`
	ChunksReceived           int    `json:"chunksReceived"`
	ChunkBytes               int    `json:"chunkBytes"`
	KeyFramesReceived        int    `json:"keyFramesReceived"`
	FirstTimestampMicros     int64  `json:"firstTimestampMicros"`
	LastTimestampMicros      int64  `json:"lastTimestampMicros"`
	MediaDurationMicros      int64  `json:"mediaDurationMicros"`
	StreamWallDurationMillis int64  `json:"streamWallDurationMillis"`
}

type liveFanoutMetrics struct {
	SourceSamples         int
	TransportSampleWrites int
}

// RunLiveBridge performs the bounded live bridge experiment. It intentionally
// has no integration point with Screener's product signaling or media router.
func RunLiveBridge(ctx context.Context, options LiveBridgeOptions) (LiveBridgeResult, error) {
	return runLiveBridge(ctx, options, liveBridgeRunOptions{})
}

func runLiveBridge(
	ctx context.Context, options LiveBridgeOptions, runOptions liveBridgeRunOptions,
) (LiveBridgeResult, error) {
	browserPath, err := resolveBrowserPath(options.BrowserPath)
	if err != nil {
		return LiveBridgeResult{}, err
	}

	run, err := newLiveBridgeRunWithOptions(ctx, runOptions)
	if err != nil {
		return LiveBridgeResult{}, err
	}
	defer run.close()

	var viewers [2]*oracleBrowserProcess
	for index := range viewers {
		viewers[index], err = launchOracleBrowser(ctx, browserPath, run.viewerURL(index), fmt.Sprintf("live-viewer-%d", index+1))
		if err != nil {
			return LiveBridgeResult{}, err
		}
		defer viewers[index].close()
	}
	if err = run.waitReady(ctx); err != nil {
		return LiveBridgeResult{}, fmt.Errorf("connect live viewers: %w%s%s", err, viewers[0].failureSuffix(), viewers[1].failureSuffix())
	}
	settle := time.NewTimer(250 * time.Millisecond)
	select {
	case <-settle.C:
	case <-ctx.Done():
		settle.Stop()
		return LiveBridgeResult{}, ctx.Err()
	}

	fanoutResult := make(chan liveFanoutMetrics, 1)
	fanoutError := make(chan error, 1)
	go func() {
		metrics, fanoutErr := fanoutLiveSamples(ctx, run.queue, run.sampleSinks())
		if fanoutErr != nil {
			run.queue.Close()
			fanoutError <- fanoutErr
			return
		}
		fanoutResult <- metrics
	}()

	host, err := launchOracleBrowser(ctx, browserPath, run.hostURL(), "live-host")
	if err != nil {
		return LiveBridgeResult{}, err
	}
	defer host.close()

	submission, err := run.waitHostSubmission(ctx)
	if err != nil {
		return LiveBridgeResult{}, fmt.Errorf("receive live host stream: %w%s", err, host.failureSuffix())
	}

	var fanout liveFanoutMetrics
	select {
	case fanout = <-fanoutResult:
	case err = <-fanoutError:
		return LiveBridgeResult{}, fmt.Errorf("fan out live source: %w", err)
	case <-ctx.Done():
		return LiveBridgeResult{}, ctx.Err()
	}
	run.markStreamComplete()

	browserMetrics, err := run.waitBrowserMetrics(ctx)
	if err != nil {
		return LiveBridgeResult{}, fmt.Errorf("wait for sustained viewer evidence: %w%s%s", err, viewers[0].failureSuffix(), viewers[1].failureSuffix())
	}

	result := run.result(submission, fanout, browserMetrics)
	if err = validateLiveBridgeResult(result, run.profile()); err != nil {
		return LiveBridgeResult{}, err
	}
	return result, nil
}

func fanoutLiveSamples(ctx context.Context, queue *liveSampleQueue, sinks []sampleSink) (liveFanoutMetrics, error) {
	if len(sinks) != 2 {
		return liveFanoutMetrics{}, fmt.Errorf("sink count = %d, want 2", len(sinks))
	}
	var metrics liveFanoutMetrics
	for {
		frame, ok, err := queue.Pop(ctx)
		if err != nil {
			return metrics, err
		}
		if !ok {
			return metrics, nil
		}
		sample := media.Sample{
			Data:     frame.Data,
			Duration: time.Duration(frame.DurationMicros) * time.Microsecond,
		}
		metrics.SourceSamples++
		for index, sink := range sinks {
			if err = sink.WriteSample(sample); err != nil {
				return metrics, fmt.Errorf("write live source sample %d to transport %d: %w", metrics.SourceSamples, index+1, err)
			}
			metrics.TransportSampleWrites++
		}
	}
}

func validateLiveBridgeResult(result LiveBridgeResult, profile liveBridgeProfile) error {
	if result.Host.EncoderInstances != 1 {
		return fmt.Errorf("host encoder instances = %d, want 1", result.Host.EncoderInstances)
	}
	if result.Host.EncoderInputCalls != profile.FrameCount || result.Host.EncoderOutputs != result.Host.EncoderInputCalls {
		return fmt.Errorf("host encoder inputs/outputs = %d/%d, want %d/%d", result.Host.EncoderInputCalls, result.Host.EncoderOutputs, profile.FrameCount, profile.FrameCount)
	}
	if result.Host.EncoderInputDrops != 0 || result.Host.SocketDroppedChunks != 0 {
		return fmt.Errorf("clean loopback run dropped encoder/socket chunks = %d/%d", result.Host.EncoderInputDrops, result.Host.SocketDroppedChunks)
	}
	if result.Host.EncoderOutputBytes != result.Host.SentChunkBytes {
		return errors.New("clean loopback run did not send every encoded output byte")
	}
	if result.Host.SentChunks != result.IPC.ChunksReceived || result.Host.SentChunkBytes != result.IPC.ChunkBytes {
		return errors.New("host and helper IPC chunk counters differ")
	}
	if result.IPC.Codec != "vp8" || result.IPC.Width != profile.Width || result.IPC.Height != profile.Height || result.IPC.FPS != profile.FPS {
		return fmt.Errorf("IPC config = %s %dx%d@%d", result.IPC.Codec, result.IPC.Width, result.IPC.Height, result.IPC.FPS)
	}
	if !result.IPC.LoopbackOnly || !result.IPC.OriginValidated || result.IPC.StartupTokenBytes != liveBridgeTokenBytes {
		return errors.New("IPC did not retain loopback, origin, and startup-token boundaries")
	}
	if time.Duration(result.IPC.MediaDurationMicros)*time.Microsecond < profile.MinDuration ||
		time.Duration(result.IPC.StreamWallDurationMillis)*time.Millisecond < profile.MinDuration {
		return fmt.Errorf("live source did not span at least %s", profile.MinDuration)
	}
	if time.Duration(result.IPC.StreamWallDurationMillis)*time.Millisecond > liveBridgeMaxDuration {
		return errors.New("live IPC run exceeded its 25 second bound")
	}
	if result.Queue.Capacity != liveBridgeQueueCapacity || result.Queue.MaxDepth > result.Queue.Capacity {
		return errors.New("helper queue exceeded its configured bound")
	}
	if result.SourceSamples != result.Queue.AcceptedChunks || result.TransportSampleWrites != result.SourceSamples*2 {
		return fmt.Errorf("source samples/writes = %d/%d, accepted = %d", result.SourceSamples, result.TransportSampleWrites, result.Queue.AcceptedChunks)
	}
	if !result.IndependentSSRC || !result.IndependentSequenceSpace || !result.IndependentICECredentials || !result.IndependentDTLSFingerprints {
		return errors.New("live downstreams did not retain independent RTP/ICE/DTLS identity")
	}
	if !result.EqualEdgePayloadBytes {
		return errors.New("live downstream RTP payload byte counts differ")
	}

	for index, downstream := range result.Downstream {
		if downstream.ConnectionState != "connected" || downstream.RTP.Packets == 0 || downstream.RTP.PayloadBytes == 0 {
			return fmt.Errorf("downstream %d has no connected native RTP path", index+1)
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
		if browser.PacketsReceived != downstream.RTP.Packets || browser.BytesReceived != downstream.RTP.PayloadBytes {
			return fmt.Errorf("downstream %d browser/native RTP counters differ", index+1)
		}
		if browser.FramesDecoded < uint64(profile.MinDecoded) || browser.RenderedFrameCallbacks < uint64(profile.MinRendered) {
			return fmt.Errorf("downstream %d decoded/rendered only %d/%d frames", index+1, browser.FramesDecoded, browser.RenderedFrameCallbacks)
		}
		if browser.KeyFramesDecoded < 2 {
			return fmt.Errorf("downstream %d decoded only %d key frames", index+1, browser.KeyFramesDecoded)
		}
		if uniqueUint32(browser.RenderedPixelHashes) < 8 {
			return fmt.Errorf("downstream %d lacks sustained changing-frame evidence", index+1)
		}
		if browser.FrameWidth != uint32(profile.Width) || browser.FrameHeight != uint32(profile.Height) {
			return fmt.Errorf("downstream %d decoded dimensions = %dx%d", index+1, browser.FrameWidth, browser.FrameHeight)
		}
	}
	return nil
}
