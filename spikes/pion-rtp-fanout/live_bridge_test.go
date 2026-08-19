package fanoutoracle

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestLiveSampleQueueDropsToNextKeyFrameWhenFull(t *testing.T) {
	queue := newLiveSampleQueue(2)
	if result, err := queue.Push(liveTestFrame("key", 0)); err != nil || !result.Accepted {
		t.Fatalf("push key = %+v, %v", result, err)
	}
	if result, err := queue.Push(liveTestFrame("delta", 1)); err != nil || !result.Accepted {
		t.Fatalf("push delta = %+v, %v", result, err)
	}
	result, err := queue.Push(liveTestFrame("delta", 2))
	if err != nil || result.Accepted || !result.RequestKeyFrame {
		t.Fatalf("overflow push = %+v, %v", result, err)
	}
	if result, err = queue.Push(liveTestFrame("delta", 3)); err != nil || result.Accepted {
		t.Fatalf("dependent delta push = %+v, %v", result, err)
	}
	if result, err = queue.Push(liveTestFrame("key", 4)); err != nil || !result.Accepted {
		t.Fatalf("recovery key push = %+v, %v", result, err)
	}
	queue.Close()

	frame, ok, err := queue.Pop(context.Background())
	if err != nil || !ok || frame.Type != "key" || frame.TimestampMicros != 4 {
		t.Fatalf("recovery pop = %+v, %v, %v", frame, ok, err)
	}
	if _, ok, err = queue.Pop(context.Background()); err != nil || ok {
		t.Fatalf("closed empty pop = %v, %v", ok, err)
	}
	metrics := queue.Snapshot()
	if metrics.Capacity != 2 || metrics.MaxDepth != 2 || metrics.OverloadEvents != 1 || metrics.KeyFrameRequests != 1 {
		t.Fatalf("queue metrics = %+v", metrics)
	}
	if metrics.AcceptedChunks != 3 || metrics.DroppedChunks != 4 {
		t.Fatalf("queue accepted/dropped = %d/%d", metrics.AcceptedChunks, metrics.DroppedChunks)
	}
}

func TestLiveSampleQueuePopHonorsCancellation(t *testing.T) {
	queue := newLiveSampleQueue(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok, err := queue.Pop(ctx); err == nil || ok {
		t.Fatalf("canceled pop = %v, %v", ok, err)
	}
}

func TestDecodeLiveChunkPreservesTimingTypeAndPayload(t *testing.T) {
	payload := make([]byte, liveChunkHeaderBytes+3)
	payload[0] = 1
	binary.BigEndian.PutUint64(payload[1:9], 123456)
	binary.BigEndian.PutUint64(payload[9:17], 33333)
	copy(payload[liveChunkHeaderBytes:], []byte{4, 5, 6})

	frame, err := decodeLiveChunk(payload)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Type != "key" || frame.TimestampMicros != 123456 || frame.DurationMicros != 33333 {
		t.Fatalf("decoded frame = %+v", frame)
	}
	if len(frame.Data) != 3 || frame.Data[0] != 4 || frame.Data[2] != 6 {
		t.Fatalf("decoded payload = %v", frame.Data)
	}
}

func TestLiveBridgeServerBindsLoopbackAndRequiresTokenAndOrigin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run, err := newLiveBridgeRun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer run.close()

	address := run.listener.Addr().(*net.TCPAddr)
	if !address.IP.IsLoopback() {
		t.Fatalf("listener address = %s", address)
	}
	if len(run.token) != liveBridgeTokenBytes*2 {
		t.Fatalf("hex token length = %d", len(run.token))
	}

	response, err := http.Get(run.baseURL() + "/host")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("missing token status = %d", response.StatusCode)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, run.baseURL()+"/api/state?token="+run.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://example.invalid")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong origin status = %d", response.StatusCode)
	}

	request, err = http.NewRequestWithContext(ctx, http.MethodPost, run.baseURL()+"/api/state?token="+run.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", run.baseURL())
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("valid origin status = %d", response.StatusCode)
	}

	request, err = http.NewRequestWithContext(ctx, http.MethodGet, run.baseURL()+"/api/live?token="+run.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", run.baseURL())
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("non-WebSocket request unexpectedly upgraded")
	}
	run.streamMu.Lock()
	claimed := run.streamClaimed
	run.streamMu.Unlock()
	if claimed {
		t.Fatal("invalid upgrade claimed the single live-stream slot")
	}
}

func TestValidateLiveConfigRejectsUnboundedHostSettings(t *testing.T) {
	config := liveBridgeConfigRecord{
		Kind:                     "config",
		Codec:                    "vp8",
		Width:                    liveBridgeWidth,
		Height:                   liveBridgeHeight,
		FPS:                      liveBridgeFPS,
		EncoderInstances:         1,
		HardwareAccelerationHint: liveBridgeHardwareAccelerationHint,
		SocketBufferedBytesLimit: liveBridgeSocketBufferLimit + 1,
		EncoderQueueLimit:        liveBridgeEncoderQueueLimit,
	}
	if err := validateLiveConfig(config); err == nil {
		t.Fatal("expected mismatched host queue limit to be rejected")
	}
}

func TestFanoutLiveSamplesWritesEveryAcceptedSampleToBothLegs(t *testing.T) {
	queue := newLiveSampleQueue(2)
	_, _ = queue.Push(liveTestFrame("key", 0))
	_, _ = queue.Push(liveTestFrame("delta", 1))
	queue.Close()
	first := &recordingSampleSink{}
	second := &recordingSampleSink{}

	metrics, err := fanoutLiveSamples(context.Background(), queue, []sampleSink{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if metrics.SourceSamples != 2 || metrics.TransportSampleWrites != 4 {
		t.Fatalf("fanout metrics = %+v", metrics)
	}
	if len(first.samples) != 2 || len(second.samples) != 2 {
		t.Fatalf("sink sample counts = %d/%d", len(first.samples), len(second.samples))
	}
}

func TestLiveBridgeWithRealChromium(t *testing.T) {
	if os.Getenv("SCREENER_RUN_LIVE_BRIDGE") != "1" {
		t.Skip("set SCREENER_RUN_LIVE_BRIDGE=1 to launch one host and two receiver browsers")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	if _, err := RunLiveBridge(ctx, LiveBridgeOptions{}); err != nil {
		t.Fatal(err)
	}
}

func liveTestFrame(frameType string, timestamp int64) encodedFrame {
	return encodedFrame{
		TimestampMicros: timestamp,
		DurationMicros:  33333,
		Type:            frameType,
		Data:            []byte{byte(timestamp + 1)},
	}
}
