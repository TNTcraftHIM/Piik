package media

import (
	"encoding/binary"
	"errors"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestFrameTimelinePreservesDroppedSourceTime(t *testing.T) {
	timeline := newFrameTimeline()
	first, _, err := timeline.Packetize(Frame{
		KeyFrame:        true,
		TimestampMicros: 0,
		DurationMicros:  33_333,
		Data:            []byte{1, 2, 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, gap, err := timeline.Packetize(Frame{
		TimestampMicros: 66_666,
		DurationMicros:  33_333,
		Data:            []byte{4, 5, 6},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gap != 33_333 {
		t.Fatalf("source gap = %d, want 33333 microseconds", gap)
	}
	if delta := second[0].Timestamp - first[0].Timestamp; delta != 6_000 {
		t.Fatalf("RTP timestamp delta = %d, want 6000 samples", delta)
	}
}

func TestFrameTimelineAcceptsCaptureJitterShorterThanReportedDuration(t *testing.T) {
	timeline := newFrameTimeline()
	first, _, err := timeline.Packetize(Frame{
		TimestampMicros: 100_000,
		DurationMicros:  33_333,
		Data:            []byte{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, gap, err := timeline.Packetize(Frame{
		TimestampMicros: 133_000,
		DurationMicros:  33_333,
		Data:            []byte{2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gap != 0 {
		t.Fatalf("capture jitter reported a source gap of %d microseconds", gap)
	}
	if delta := second[0].Timestamp - first[0].Timestamp; delta != 2_970 {
		t.Fatalf("RTP timestamp delta = %d, want 2970 samples", delta)
	}
}

func TestFrameTimelineRejectsNonIncreasingSourceTime(t *testing.T) {
	for _, timestamp := range []uint64{100, 99} {
		timeline := newFrameTimeline()
		if _, _, err := timeline.Packetize(Frame{
			TimestampMicros: 100,
			DurationMicros:  1,
			Data:            []byte{1},
		}); err != nil {
			t.Fatal(err)
		}
		if _, _, err := timeline.Packetize(Frame{
			TimestampMicros: timestamp,
			DurationMicros:  1,
			Data:            []byte{2},
		}); err == nil {
			t.Fatalf("non-increasing source timestamp %d was accepted", timestamp)
		}
	}
}

func TestFrameTimelineAdvancesForPositiveSubsampleDelta(t *testing.T) {
	timeline := newFrameTimeline()
	first, _, err := timeline.Packetize(Frame{TimestampMicros: 1, DurationMicros: 1, Data: []byte{1}})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := timeline.Packetize(Frame{TimestampMicros: 2, DurationMicros: 1, Data: []byte{2}})
	if err != nil {
		t.Fatal(err)
	}
	if delta := second[0].Timestamp - first[0].Timestamp; delta != 1 {
		t.Fatalf("RTP timestamp delta = %d, want 1 sample", delta)
	}
}

func TestH264TimelinePacketizesAnnexBWithInBandParameterSets(t *testing.T) {
	timeline := newFrameTimelineForCodec(CodecH264)
	accessUnit := []byte{
		0, 0, 0, 1, 0x09, 0xf0,
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f,
		0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21,
	}
	packets, _, err := timeline.Packetize(Frame{
		KeyFrame: true, TimestampMicros: 1, DurationMicros: 33_333, Data: accessUnit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(packets) < 2 {
		t.Fatalf("H.264 access unit yielded %d RTP packets", len(packets))
	}
	if packets[0].Payload[0]&0x1f != 24 {
		t.Fatalf("first H.264 payload type = %d, want STAP-A (24)", packets[0].Payload[0]&0x1f)
	}
}

func TestH264TrackCapabilityUsesFixtureProfile(t *testing.T) {
	capability, err := trackCapability(CodecH264)
	if err != nil {
		t.Fatal(err)
	}
	if capability.MimeType != webrtc.MimeTypeH264 || capability.SDPFmtpLine != H264SDPFmtpLine {
		t.Fatalf("H.264 capability = %+v", capability)
	}
}

func TestFanoutPropagatesWriterFailure(t *testing.T) {
	written := make(chan struct{}, 1)
	fatal := make(chan error, 1)
	fanout := newFanout(nil, rtpWriterFunc(func(*rtp.Packet) error {
		written <- struct{}{}
		return errors.New("write failed")
	}), nil, func(err error) { fatal <- err })

	if err := fanout.Push(Frame{
		KeyFrame:        true,
		TimestampMicros: 1,
		DurationMicros:  33_333,
		Data:            []byte{1},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-written:
	case <-time.After(time.Second):
		t.Fatal("writer was not called")
	}
	select {
	case err := <-fatal:
		if err == nil || err.Error() != "write shared RTP packet failed" {
			t.Fatalf("fatal error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("writer failure was not propagated")
	}
	fanout.Close()
}

func TestFanoutCloseDropsBacklogWithoutLateWritesOrFatal(t *testing.T) {
	writer := &blockingWriter{started: make(chan struct{}), release: make(chan struct{})}
	fatal := make(chan error, 1)
	fanout := newFanout(nil, writer, nil, func(err error) { fatal <- err })

	if err := fanout.Push(Frame{KeyFrame: true, TimestampMicros: 1, DurationMicros: 1, Data: []byte{1}}); err != nil {
		t.Fatal(err)
	}
	<-writer.started
	for timestamp := uint64(2); timestamp <= 5; timestamp++ {
		if err := fanout.Push(Frame{TimestampMicros: timestamp, DurationMicros: 1, Data: []byte{1}}); err != nil {
			t.Fatal(err)
		}
	}

	closed := make(chan struct{})
	go func() {
		fanout.Close()
		close(closed)
	}()
	deadline := time.Now().Add(time.Second)
	for fanout.Snapshot().Queue.ShutdownDroppedFrames != 4 {
		if time.Now().After(deadline) {
			t.Fatal("fanout close did not discard the queued backlog")
		}
		runtime.Gosched()
	}
	close(writer.release)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("fanout close did not wait for the writer loop")
	}
	if writes := writer.Writes(); writes != 1 {
		t.Fatalf("writes after close = %d, want only the in-flight write", writes)
	}
	select {
	case err := <-fatal:
		t.Fatalf("close reported a fatal error: %v", err)
	default:
	}
}

func TestDecodeFrame(t *testing.T) {
	payload := make([]byte, FrameHeaderBytes+3)
	payload[0] = 1
	binary.BigEndian.PutUint64(payload[1:9], 123)
	binary.BigEndian.PutUint64(payload[9:17], 33_333)
	copy(payload[17:], []byte{1, 2, 3})

	frame, err := DecodeFrame(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !frame.KeyFrame || frame.TimestampMicros != 123 || frame.DurationMicros != 33_333 {
		t.Fatalf("decoded frame = %+v", frame)
	}
}

type rtpWriterFunc func(*rtp.Packet) error

func (write rtpWriterFunc) WriteRTP(packet *rtp.Packet) error {
	return write(packet)
}

type blockingWriter struct {
	mu      sync.Mutex
	started chan struct{}
	release chan struct{}
	writes  int
	once    sync.Once
}

func (writer *blockingWriter) WriteRTP(*rtp.Packet) error {
	writer.once.Do(func() { close(writer.started) })
	<-writer.release
	writer.mu.Lock()
	writer.writes++
	writer.mu.Unlock()
	return nil
}

func (writer *blockingWriter) Writes() int {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.writes
}
