package fanoutoracle

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const liveChunkHeaderBytes = 17

type liveBridgeRun struct {
	ctx            context.Context
	options        liveBridgeRunOptions
	token          string
	listener       net.Listener
	server         *http.Server
	queue          *liveSampleQueue
	submission     chan liveBridgeSubmission
	hostError      chan error
	browserError   chan error
	ready          [2]chan struct{}
	readyOnce      [2]sync.Once
	metrics        [2]chan BrowserMetrics
	legsMu         sync.Mutex
	legs           [2]*browserPeerLeg
	streamMu       sync.Mutex
	streamClaimed  bool
	stateMu        sync.RWMutex
	streamComplete bool
	streamFailure  string
}

type liveBridgeSubmission struct {
	Host LiveBridgeHostMetrics
	IPC  LiveBridgeIPCMetrics
}

type liveBridgeConfigRecord struct {
	Kind                     string `json:"kind"`
	Codec                    string `json:"codec"`
	Width                    int    `json:"width"`
	Height                   int    `json:"height"`
	FPS                      int    `json:"fps"`
	EncoderInstances         int    `json:"encoderInstances"`
	HardwareAccelerationHint string `json:"hardwareAccelerationHint"`
	SocketBufferedBytesLimit int    `json:"socketBufferedBytesLimit"`
	EncoderQueueLimit        int    `json:"encoderQueueLimit"`
}

type liveBridgeCompleteRecord struct {
	Kind string                `json:"kind"`
	Host LiveBridgeHostMetrics `json:"host"`
}

type liveBridgeRecordKind struct {
	Kind string `json:"kind"`
}

type liveBridgeKeyFrameRequest struct {
	Kind       string `json:"kind"`
	Generation uint64 `json:"generation"`
}

type liveBridgeState struct {
	Complete                bool   `json:"complete"`
	RetransmissionRecovered bool   `json:"retransmissionRecovered"`
	Error                   string `json:"error,omitempty"`
}

func newLiveBridgeRun(ctx context.Context) (*liveBridgeRun, error) {
	return newLiveBridgeRunWithOptions(ctx, liveBridgeRunOptions{})
}

type liveBridgeRunOptions struct {
	primaryRetransmission bool
}

func newLiveBridgeRunWithOptions(ctx context.Context, options liveBridgeRunOptions) (*liveBridgeRun, error) {
	tokenBytes := make([]byte, liveBridgeTokenBytes)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate live bridge startup token: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for live bridge on loopback: %w", err)
	}

	run := &liveBridgeRun{
		ctx:          ctx,
		options:      options,
		token:        hex.EncodeToString(tokenBytes),
		listener:     listener,
		queue:        newLiveSampleQueue(liveBridgeQueueCapacity),
		submission:   make(chan liveBridgeSubmission, 1),
		hostError:    make(chan error, 1),
		browserError: make(chan error, 2),
	}
	for index := 0; index < 2; index++ {
		run.ready[index] = make(chan struct{})
		run.metrics[index] = make(chan BrowserMetrics, 1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/host", run.handleHostPage)
	mux.HandleFunc("/viewer", run.handleViewerPage)
	mux.HandleFunc("/api/live", run.handleLiveSocket)
	mux.HandleFunc("/api/host-error", run.handleHostError)
	mux.HandleFunc("/api/offer", run.handleOffer)
	mux.HandleFunc("/api/answer", run.handleAnswer)
	mux.HandleFunc("/api/ready", run.handleReady)
	mux.HandleFunc("/api/state", run.handleState)
	mux.HandleFunc("/api/result", run.handleResult)
	run.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 2 * time.Second,
		IdleTimeout:       5 * time.Second,
	}
	go func() {
		_ = run.server.Serve(listener)
	}()
	return run, nil
}

func (run *liveBridgeRun) baseURL() string {
	return "http://" + run.listener.Addr().String()
}

func (run *liveBridgeRun) hostURL() string {
	return run.baseURL() + "/host?token=" + run.token
}

func (run *liveBridgeRun) viewerURL(index int) string {
	return fmt.Sprintf("%s/viewer?token=%s&id=%d", run.baseURL(), run.token, index+1)
}

func (run *liveBridgeRun) handleHostPage(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePage(response, request) {
		return
	}
	writeLivePage(response, liveBridgeHostPage(run.token))
}

func (run *liveBridgeRun) handleViewerPage(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePage(response, request) {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	writeLivePage(response, liveBridgeViewerPage(run.token, index))
}

func writeLivePage(response http.ResponseWriter, page string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = response.Write([]byte(page))
}

func (run *liveBridgeRun) handleLiveSocket(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodGet) {
		return
	}
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		run.failStream(fmt.Errorf("accept live IPC WebSocket: %w", err))
		return
	}
	defer connection.CloseNow()
	run.streamMu.Lock()
	if run.streamClaimed {
		run.streamMu.Unlock()
		_ = connection.Close(websocket.StatusPolicyViolation, "live stream already connected")
		return
	}
	run.streamClaimed = true
	run.streamMu.Unlock()
	connection.SetReadLimit(liveBridgeMaxChunkBytes + liveChunkHeaderBytes)

	submission, err := run.readLiveSocket(connection)
	if err != nil {
		run.queue.Close()
		run.failStream(err)
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid live stream")
		return
	}
	run.queue.Close()
	select {
	case run.submission <- submission:
	default:
		run.failStream(errors.New("live stream submitted more than once"))
	}
	_ = connection.Close(websocket.StatusNormalClosure, "live stream complete")
}

func (run *liveBridgeRun) readLiveSocket(connection *websocket.Conn) (liveBridgeSubmission, error) {
	var config *liveBridgeConfigRecord
	ipc := LiveBridgeIPCMetrics{
		Transport:            "loopback-websocket",
		BindAddress:          run.listener.Addr().String(),
		LoopbackOnly:         run.listener.Addr().(*net.TCPAddr).IP.IsLoopback(),
		OriginValidated:      true,
		StartupTokenBytes:    liveBridgeTokenBytes,
		FirstTimestampMicros: -1,
	}
	previousTimestamp := int64(-1)
	var started time.Time
	var keyFrameGeneration uint64

	for {
		messageType, payload, err := connection.Read(run.ctx)
		if err != nil {
			return liveBridgeSubmission{}, fmt.Errorf("read live IPC message: %w", err)
		}
		switch messageType {
		case websocket.MessageText:
			var kind liveBridgeRecordKind
			if err = json.Unmarshal(payload, &kind); err != nil || kind.Kind == "" {
				return liveBridgeSubmission{}, errors.New("live IPC text record has no valid kind")
			}
			switch kind.Kind {
			case "config":
				if config != nil || ipc.ChunksReceived != 0 {
					return liveBridgeSubmission{}, errors.New("live IPC config must be the first record")
				}
				var received liveBridgeConfigRecord
				if err = decodeStrictLiveJSON(payload, &received); err != nil {
					return liveBridgeSubmission{}, err
				}
				if err = validateLiveConfig(received); err != nil {
					return liveBridgeSubmission{}, err
				}
				config = &received
				ipc.Codec = received.Codec
				ipc.Width = received.Width
				ipc.Height = received.Height
				ipc.FPS = received.FPS
				ipc.HardwareAccelerationHint = received.HardwareAccelerationHint
				started = time.Now()
			case "complete":
				if config == nil || ipc.ChunksReceived == 0 {
					return liveBridgeSubmission{}, errors.New("live IPC completed before config and chunks")
				}
				var complete liveBridgeCompleteRecord
				if err = decodeStrictLiveJSON(payload, &complete); err != nil {
					return liveBridgeSubmission{}, err
				}
				ipc.StreamWallDurationMillis = time.Since(started).Milliseconds()
				if err = validateLiveCompletion(*config, complete.Host, ipc); err != nil {
					return liveBridgeSubmission{}, err
				}
				return liveBridgeSubmission{Host: complete.Host, IPC: ipc}, nil
			default:
				return liveBridgeSubmission{}, fmt.Errorf("unknown live IPC text record %q", kind.Kind)
			}
		case websocket.MessageBinary:
			if config == nil {
				return liveBridgeSubmission{}, errors.New("live IPC chunk arrived before config")
			}
			frame, decodeErr := decodeLiveChunk(payload)
			if decodeErr != nil {
				return liveBridgeSubmission{}, decodeErr
			}
			if previousTimestamp >= frame.TimestampMicros {
				return liveBridgeSubmission{}, errors.New("live IPC timestamps are not strictly increasing")
			}
			if ipc.ChunksReceived == 0 && frame.Type != "key" {
				return liveBridgeSubmission{}, errors.New("live IPC does not start with a key frame")
			}
			if ipc.ChunksReceived == 0 {
				ipc.FirstTimestampMicros = frame.TimestampMicros
			}
			if ipc.ChunksReceived >= liveBridgeMaxReceivedChunks || ipc.ChunkBytes > liveBridgeMaxStreamBytes-len(frame.Data) {
				return liveBridgeSubmission{}, errors.New("live IPC stream exceeds its chunk or byte bound")
			}
			if time.Since(started) > liveBridgeMaxDuration {
				return liveBridgeSubmission{}, errors.New("live IPC stream exceeds its wall-clock bound")
			}
			previousTimestamp = frame.TimestampMicros
			ipc.LastTimestampMicros = frame.TimestampMicros
			ipc.MediaDurationMicros = frame.TimestampMicros - ipc.FirstTimestampMicros + frame.DurationMicros
			ipc.ChunksReceived++
			ipc.ChunkBytes += len(frame.Data)
			if frame.Type == "key" {
				ipc.KeyFramesReceived++
			}
			push, pushErr := run.queue.Push(frame)
			if pushErr != nil {
				return liveBridgeSubmission{}, pushErr
			}
			if push.RequestKeyFrame {
				keyFrameGeneration++
				control, marshalErr := json.Marshal(liveBridgeKeyFrameRequest{Kind: "request-keyframe", Generation: keyFrameGeneration})
				if marshalErr != nil {
					return liveBridgeSubmission{}, marshalErr
				}
				writeContext, cancel := context.WithTimeout(run.ctx, time.Second)
				writeErr := connection.Write(writeContext, websocket.MessageText, control)
				cancel()
				if writeErr != nil {
					return liveBridgeSubmission{}, fmt.Errorf("request recovery key frame: %w", writeErr)
				}
			}
		default:
			return liveBridgeSubmission{}, errors.New("unsupported live IPC WebSocket message type")
		}
	}
}

func decodeLiveChunk(payload []byte) (encodedFrame, error) {
	if len(payload) <= liveChunkHeaderBytes {
		return encodedFrame{}, errors.New("live IPC chunk is empty or truncated")
	}
	if len(payload)-liveChunkHeaderBytes > liveBridgeMaxChunkBytes {
		return encodedFrame{}, errors.New("live IPC chunk exceeds 1 MiB")
	}
	frameType := ""
	switch payload[0] {
	case 1:
		frameType = "key"
	case 2:
		frameType = "delta"
	default:
		return encodedFrame{}, errors.New("live IPC chunk has an invalid frame type")
	}
	timestamp := binary.BigEndian.Uint64(payload[1:9])
	duration := binary.BigEndian.Uint64(payload[9:17])
	if timestamp > uint64(^uint64(0)>>1) || duration == 0 || duration > uint64(time.Second/time.Microsecond) {
		return encodedFrame{}, errors.New("live IPC chunk has invalid timing")
	}
	return encodedFrame{
		TimestampMicros: int64(timestamp),
		DurationMicros:  int64(duration),
		Type:            frameType,
		Data:            append([]byte(nil), payload[liveChunkHeaderBytes:]...),
	}, nil
}

func validateLiveConfig(config liveBridgeConfigRecord) error {
	if config.Kind != "config" || config.Codec != "vp8" {
		return errors.New("live IPC requires a VP8 config record")
	}
	if config.Width != liveBridgeWidth || config.Height != liveBridgeHeight || config.FPS != liveBridgeFPS {
		return fmt.Errorf("live IPC format = %dx%d@%d", config.Width, config.Height, config.FPS)
	}
	if config.EncoderInstances != 1 {
		return fmt.Errorf("live IPC encoder instances = %d, want 1", config.EncoderInstances)
	}
	if config.HardwareAccelerationHint != liveBridgeHardwareAccelerationHint {
		return fmt.Errorf("unexpected hardware acceleration hint %q", config.HardwareAccelerationHint)
	}
	if config.SocketBufferedBytesLimit != liveBridgeSocketBufferLimit || config.EncoderQueueLimit != liveBridgeEncoderQueueLimit {
		return errors.New("live host queue limits differ from the oracle contract")
	}
	return nil
}

func validateLiveCompletion(config liveBridgeConfigRecord, host LiveBridgeHostMetrics, ipc LiveBridgeIPCMetrics) error {
	if host.EncoderInstances != config.EncoderInstances || host.HardwareAccelerationHint != config.HardwareAccelerationHint {
		return errors.New("live completion does not match the initial encoder config")
	}
	if host.SocketBufferedBytesLimit != config.SocketBufferedBytesLimit || host.EncoderQueueLimit != config.EncoderQueueLimit {
		return errors.New("live completion does not match the initial queue config")
	}
	if host.SentChunks != ipc.ChunksReceived || host.SentChunkBytes != ipc.ChunkBytes {
		return errors.New("live completion chunk counters differ from helper observations")
	}
	if host.EncoderOutputs != host.SentChunks+host.SocketDroppedChunks {
		return errors.New("live completion does not account for every encoder output")
	}
	if host.EncoderInputCalls+host.EncoderInputDrops != liveBridgeFrameCount {
		return errors.New("live completion does not account for every scheduled input frame")
	}
	if host.MaxEncoderQueueSize > host.EncoderQueueLimit {
		return errors.New("host WebCodecs queue exceeded its configured limit")
	}
	if host.MaxSocketBufferedBytes > host.SocketBufferedBytesLimit {
		return errors.New("host WebSocket buffer exceeded its configured limit")
	}
	if host.ElapsedMillis < liveBridgeMinDuration.Milliseconds() || host.ElapsedMillis > liveBridgeMaxDuration.Milliseconds() {
		return errors.New("host live stream duration is outside the bounded window")
	}
	return nil
}

func decodeStrictLiveJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode live IPC JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode trailing live IPC JSON: %w", err)
	}
	return errors.New("multiple live IPC JSON values are not allowed")
}

func (run *liveBridgeRun) handleHostError(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	var report browserErrorJSON
	if err := decodeOracleJSON(response, request, &report); err != nil || report.Error == "" {
		http.Error(response, "invalid host error", http.StatusBadRequest)
		return
	}
	run.failStream(errors.New(report.Error))
	response.WriteHeader(http.StatusNoContent)
}

func (run *liveBridgeRun) handleOffer(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	leg, err := run.createLeg(index)
	if err != nil {
		http.Error(response, err.Error(), http.StatusInternalServerError)
		return
	}
	offer, err := leg.createOffer(run.ctx)
	if err != nil {
		http.Error(response, err.Error(), http.StatusInternalServerError)
		return
	}
	writeOracleJSON(response, sessionDescriptionJSON{Type: offer.Type.String(), SDP: offer.SDP})
}

func (run *liveBridgeRun) handleAnswer(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	leg := run.leg(index)
	if leg == nil {
		http.Error(response, "offer has not been created", http.StatusConflict)
		return
	}
	var answer sessionDescriptionJSON
	if err = decodeOracleJSON(response, request, &answer); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	sdpType := webrtc.NewSDPType(answer.Type)
	if sdpType != webrtc.SDPTypeAnswer || answer.SDP == "" {
		http.Error(response, "expected a non-empty answer", http.StatusBadRequest)
		return
	}
	if err = leg.setAnswer(webrtc.SessionDescription{Type: sdpType, SDP: answer.SDP}); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (run *liveBridgeRun) handleReady(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if run.leg(index) == nil {
		http.Error(response, "peer has not been created", http.StatusConflict)
		return
	}
	run.readyOnce[index].Do(func() { close(run.ready[index]) })
	response.WriteHeader(http.StatusNoContent)
}

func (run *liveBridgeRun) handleState(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	run.stateMu.RLock()
	state := liveBridgeState{Complete: run.streamComplete, Error: run.streamFailure}
	run.stateMu.RUnlock()
	if request.URL.Query().Get("id") != "" {
		if index, err := viewerIndex(request); err == nil {
			if leg := run.leg(index); leg != nil && leg.loss != nil {
				state.RetransmissionRecovered = leg.loss.isRecovered()
			}
		}
	}
	writeOracleJSON(response, state)
}

func (run *liveBridgeRun) handleResult(response http.ResponseWriter, request *http.Request) {
	if !run.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	var metrics BrowserMetrics
	if err = decodeOracleJSON(response, request, &metrics); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if metrics.Error != "" {
		select {
		case run.browserError <- fmt.Errorf("viewer %d: %s", index+1, metrics.Error):
		default:
		}
	}
	select {
	case run.metrics[index] <- metrics:
		response.WriteHeader(http.StatusNoContent)
	default:
		http.Error(response, "result already submitted", http.StatusConflict)
	}
}

func (run *liveBridgeRun) authorizePage(response http.ResponseWriter, request *http.Request) bool {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if request.URL.Query().Get("token") != run.token {
		http.Error(response, "not found", http.StatusNotFound)
		return false
	}
	return true
}

func (run *liveBridgeRun) authorizeAPI(response http.ResponseWriter, request *http.Request, method string) bool {
	if request.URL.Query().Get("token") != run.token {
		http.Error(response, "not found", http.StatusNotFound)
		return false
	}
	if request.Header.Get("Origin") != run.baseURL() {
		http.Error(response, "forbidden origin", http.StatusForbidden)
		return false
	}
	if request.Method != method {
		response.Header().Set("Allow", method)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func (run *liveBridgeRun) createLeg(index int) (*browserPeerLeg, error) {
	run.legsMu.Lock()
	defer run.legsMu.Unlock()
	if run.legs[index] != nil {
		return nil, errors.New("offer already created")
	}
	peerOptions := browserPeerLegOptions{}
	if run.options.primaryRetransmission {
		peerOptions.primaryRetransmission = true
		if index == 0 {
			peerOptions.dropAttempt = primaryRetransmissionDropAttempt
		}
	}
	leg, err := newBrowserPeerLegWithOptions(index, peerOptions)
	if err != nil {
		return nil, err
	}
	run.legs[index] = leg
	return leg, nil
}

func (run *liveBridgeRun) leg(index int) *browserPeerLeg {
	run.legsMu.Lock()
	defer run.legsMu.Unlock()
	return run.legs[index]
}

func (run *liveBridgeRun) waitReady(ctx context.Context) error {
	for index := 0; index < 2; index++ {
		select {
		case <-run.ready[index]:
		case err := <-run.browserError:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
		leg := run.leg(index)
		if leg == nil {
			return fmt.Errorf("viewer %d became ready without a native peer", index+1)
		}
		if err := leg.waitConnected(ctx); err != nil {
			return fmt.Errorf("viewer %d: %w", index+1, err)
		}
	}
	return nil
}

func (run *liveBridgeRun) sampleSinks() []sampleSink {
	return []sampleSink{run.leg(0).track, run.leg(1).track}
}

func (run *liveBridgeRun) waitHostSubmission(ctx context.Context) (liveBridgeSubmission, error) {
	select {
	case submission := <-run.submission:
		return submission, nil
	case err := <-run.hostError:
		return liveBridgeSubmission{}, err
	case err := <-run.browserError:
		return liveBridgeSubmission{}, err
	case <-ctx.Done():
		return liveBridgeSubmission{}, ctx.Err()
	}
}

func (run *liveBridgeRun) waitBrowserMetrics(ctx context.Context) ([2]BrowserMetrics, error) {
	var result [2]BrowserMetrics
	for index := 0; index < 2; index++ {
		select {
		case result[index] = <-run.metrics[index]:
		case err := <-run.browserError:
			return result, err
		case <-ctx.Done():
			return result, ctx.Err()
		}
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if run.leg(0).rtcp.snapshot().ReceiverReports > 0 && run.leg(1).rtcp.snapshot().ReceiverReports > 0 {
			return result, nil
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return result, ctx.Err()
		}
	}
}

func (run *liveBridgeRun) markStreamComplete() {
	run.stateMu.Lock()
	run.streamComplete = true
	run.stateMu.Unlock()
}

func (run *liveBridgeRun) failStream(err error) {
	run.stateMu.Lock()
	if run.streamFailure == "" {
		run.streamFailure = err.Error()
	}
	run.stateMu.Unlock()
	select {
	case run.hostError <- err:
	default:
	}
}

func (run *liveBridgeRun) result(submission liveBridgeSubmission, fanout liveFanoutMetrics, browser [2]BrowserMetrics) LiveBridgeResult {
	result := LiveBridgeResult{
		Host:                  submission.Host,
		IPC:                   submission.IPC,
		Queue:                 run.queue.Snapshot(),
		SourceSamples:         fanout.SourceSamples,
		TransportSampleWrites: fanout.TransportSampleWrites,
		HardStops: []string{
			"the hardwareAcceleration setting is a hint; physical or hardware encode reuse is not proven",
			"audio and A/V synchronization are not implemented",
			"two-edge send-side BWE aggregation is not implemented",
			"viewer PLI/FIR aggregation and downstream-driven keyframe policy are not implemented",
			"NACK/RTX loss recovery, pacing, and asymmetric-loss isolation are not implemented",
			"TURN, reconnect, and product-controller integration are not implemented",
		},
	}
	for index := 0; index < 2; index++ {
		leg := run.leg(index)
		result.Downstream[index] = BrowserDownstream{
			ID:                index + 1,
			ConnectionState:   leg.connectionState(),
			OfferICEUfrag:     sdpAttribute(leg.offer.SDP, "a=ice-ufrag:"),
			AnswerICEUfrag:    sdpAttribute(leg.answer.SDP, "a=ice-ufrag:"),
			OfferFingerprint:  sdpAttribute(leg.offer.SDP, "a=fingerprint:"),
			AnswerFingerprint: sdpAttribute(leg.answer.SDP, "a=fingerprint:"),
			RTP:               leg.rtp.snapshot(),
			RTCP:              leg.rtcp.snapshot(),
			Browser:           browser[index],
		}
	}
	result.IndependentSSRC = nonZeroDifferent(result.Downstream[0].RTP.SSRC, result.Downstream[1].RTP.SSRC)
	result.IndependentSequenceSpace = result.Downstream[0].RTP.FirstSequence != result.Downstream[1].RTP.FirstSequence
	result.IndependentICECredentials = nonEmptyDifferent(result.Downstream[0].OfferICEUfrag, result.Downstream[1].OfferICEUfrag) &&
		nonEmptyDifferent(result.Downstream[0].AnswerICEUfrag, result.Downstream[1].AnswerICEUfrag)
	result.IndependentDTLSFingerprints = nonEmptyDifferent(result.Downstream[0].OfferFingerprint, result.Downstream[1].OfferFingerprint) &&
		nonEmptyDifferent(result.Downstream[0].AnswerFingerprint, result.Downstream[1].AnswerFingerprint)
	result.EqualEdgePayloadBytes = result.Downstream[0].RTP.PayloadBytes != 0 &&
		result.Downstream[0].RTP.PayloadBytes == result.Downstream[1].RTP.PayloadBytes
	if run.options.primaryRetransmission {
		result.PrimaryRetransmission = run.primaryRetransmissionMetrics()
	}
	return result
}

func (run *liveBridgeRun) close() {
	run.queue.Close()
	shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = run.server.Shutdown(shutdownContext)
	for index := 0; index < 2; index++ {
		if leg := run.leg(index); leg != nil {
			leg.close()
		}
	}
}
