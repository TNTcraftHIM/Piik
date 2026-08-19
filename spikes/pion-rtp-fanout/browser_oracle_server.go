package fanoutoracle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const browserOracleHTTPBodyLimit = 12 << 20

type browserOracleRun struct {
	ctx          context.Context
	token        string
	listener     net.Listener
	server       *http.Server
	fixture      chan fixtureSubmission
	fixtureError chan error
	browserError chan error
	ready        [2]chan struct{}
	readyOnce    [2]sync.Once
	metrics      [2]chan BrowserMetrics
	legsMu       sync.Mutex
	legs         [2]*browserPeerLeg
}

type sessionDescriptionJSON struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type browserErrorJSON struct {
	Error string `json:"error"`
}

func newBrowserOracleRun(ctx context.Context) (*browserOracleRun, error) {
	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate run token: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}

	run := &browserOracleRun{
		ctx:          ctx,
		token:        hex.EncodeToString(tokenBytes),
		listener:     listener,
		fixture:      make(chan fixtureSubmission, 1),
		fixtureError: make(chan error, 1),
		browserError: make(chan error, 2),
	}
	for index := 0; index < 2; index++ {
		run.ready[index] = make(chan struct{})
		run.metrics[index] = make(chan BrowserMetrics, 1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/fixture", run.handleFixturePage)
	mux.HandleFunc("/viewer", run.handleViewerPage)
	mux.HandleFunc("/api/fixture", run.handleFixture)
	mux.HandleFunc("/api/fixture-error", run.handleFixtureError)
	mux.HandleFunc("/api/offer", run.handleOffer)
	mux.HandleFunc("/api/answer", run.handleAnswer)
	mux.HandleFunc("/api/ready", run.handleReady)
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

func (run *browserOracleRun) baseURL() string {
	return "http://" + run.listener.Addr().String()
}

func (run *browserOracleRun) fixtureURL() string {
	return run.baseURL() + "/fixture?token=" + run.token
}

func (run *browserOracleRun) viewerURL(index int) string {
	return fmt.Sprintf("%s/viewer?token=%s&id=%d", run.baseURL(), run.token, index+1)
}

func (run *browserOracleRun) handleFixturePage(response http.ResponseWriter, request *http.Request) {
	if !run.authorize(response, request) || request.Method != http.MethodGet {
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = response.Write([]byte(fixtureOraclePage(run.token)))
}

func (run *browserOracleRun) handleViewerPage(response http.ResponseWriter, request *http.Request) {
	if !run.authorize(response, request) || request.Method != http.MethodGet {
		return
	}
	index, err := viewerIndex(request)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = response.Write([]byte(viewerOraclePage(run.token, index)))
}

func (run *browserOracleRun) handleFixture(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
		return
	}
	var fixture fixtureSubmission
	if err := decodeOracleJSON(response, request, &fixture); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateFixture(fixture); err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	select {
	case run.fixture <- fixture:
		response.WriteHeader(http.StatusNoContent)
	default:
		http.Error(response, "fixture already submitted", http.StatusConflict)
	}
}

func (run *browserOracleRun) handleFixtureError(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
		return
	}
	var report browserErrorJSON
	if err := decodeOracleJSON(response, request, &report); err != nil || report.Error == "" {
		http.Error(response, "invalid fixture error", http.StatusBadRequest)
		return
	}
	select {
	case run.fixtureError <- errors.New(report.Error):
	default:
	}
	response.WriteHeader(http.StatusNoContent)
}

func (run *browserOracleRun) handleOffer(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
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

func (run *browserOracleRun) handleAnswer(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
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

func (run *browserOracleRun) handleReady(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
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

func (run *browserOracleRun) handleResult(response http.ResponseWriter, request *http.Request) {
	if !run.authorizePOST(response, request) {
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

func (run *browserOracleRun) authorize(response http.ResponseWriter, request *http.Request) bool {
	if request.URL.Query().Get("token") != run.token {
		http.Error(response, "not found", http.StatusNotFound)
		return false
	}
	return true
}

func (run *browserOracleRun) authorizePOST(response http.ResponseWriter, request *http.Request) bool {
	if !run.authorize(response, request) {
		return false
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func decodeOracleJSON(response http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(response, request.Body, browserOracleHTTPBodyLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode trailing JSON: %w", err)
	}
	return errors.New("multiple JSON values are not allowed")
}

func writeOracleJSON(response http.ResponseWriter, value any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(value)
}

func viewerIndex(request *http.Request) (int, error) {
	id, err := strconv.Atoi(request.URL.Query().Get("id"))
	if err != nil || id < 1 || id > 2 {
		return 0, errors.New("viewer id must be 1 or 2")
	}
	return id - 1, nil
}

func (run *browserOracleRun) createLeg(index int) (*browserPeerLeg, error) {
	run.legsMu.Lock()
	defer run.legsMu.Unlock()
	if run.legs[index] != nil {
		return nil, errors.New("offer already created")
	}
	leg, err := newBrowserPeerLeg(index)
	if err != nil {
		return nil, err
	}
	run.legs[index] = leg
	return leg, nil
}

func (run *browserOracleRun) leg(index int) *browserPeerLeg {
	run.legsMu.Lock()
	defer run.legsMu.Unlock()
	return run.legs[index]
}

func (run *browserOracleRun) waitFixture(ctx context.Context) (fixtureSubmission, error) {
	select {
	case fixture := <-run.fixture:
		return fixture, nil
	case err := <-run.fixtureError:
		return fixtureSubmission{}, err
	case <-ctx.Done():
		return fixtureSubmission{}, ctx.Err()
	}
}

func (run *browserOracleRun) waitReady(ctx context.Context) error {
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

func (run *browserOracleRun) sampleSinks() []sampleSink {
	return []sampleSink{run.leg(0).track, run.leg(1).track}
}

func (run *browserOracleRun) waitBrowserMetrics(ctx context.Context) ([2]BrowserMetrics, error) {
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

	// Receiver reports are periodic and may arrive just after the browser has
	// already accumulated enough decoded/rendered frames.
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

func (run *browserOracleRun) result(fixture fixtureSubmission, browser [2]BrowserMetrics, sourceSamples, transportWrites int) BrowserOracleResult {
	result := BrowserOracleResult{
		Fixture:               fixtureMetrics(fixture),
		SourceSamples:         sourceSamples,
		TransportSampleWrites: transportWrites,
		HardStops: []string{
			"send-side bandwidth estimation and two-edge target aggregation are not implemented",
			"PLI/FIR coalescing and encoder keyframe control are not implemented",
			"asymmetric-loss NACK/RTX recovery, pacing, and retransmission bounds are not verified",
		},
	}
	for index := 0; index < 2; index++ {
		leg := run.leg(index)
		result.BrowserUserAgents[index] = browser[index].UserAgent
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
	return result
}

func sdpAttribute(sdp, prefix string) string {
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return strings.TrimPrefix(line, prefix)
		}
	}
	return ""
}

func nonEmptyDifferent(first, second string) bool {
	return first != "" && second != "" && first != second
}

func nonZeroDifferent(first, second uint32) bool {
	return first != 0 && second != 0 && first != second
}

func (run *browserOracleRun) close() {
	shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = run.server.Shutdown(shutdownContext)
	for index := 0; index < 2; index++ {
		if leg := run.leg(index); leg != nil {
			leg.close()
		}
	}
}
