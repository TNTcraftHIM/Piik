package media

import (
	"context"
	"strings"
	"testing"
)

func TestFrameQueueRecoversAtAKeyFrameAfterOneOverload(t *testing.T) {
	queue := newFrameQueue(2)
	defer queue.Close()

	pushFrame(t, queue, false, 1)
	pushFrame(t, queue, false, 2)
	result, err := queue.Push(testFrame(false, 3))
	if err != nil {
		t.Fatalf("first overload returned an error: %v", err)
	}
	if result.accepted || !result.requestKeyFrame {
		t.Fatalf("first overload result = %+v, want dropped frame and key-frame request", result)
	}
	result, err = queue.Push(testFrame(false, 4))
	if err != nil || result.accepted || result.requestKeyFrame {
		t.Fatalf("recovery delta result = %+v, %v", result, err)
	}
	result, err = queue.Push(testFrame(true, 5))
	if err != nil || !result.accepted {
		t.Fatalf("recovery key frame result = %+v, %v", result, err)
	}

	frame, ok, err := queue.Pop(context.Background())
	if err != nil || !ok || !frame.KeyFrame || frame.TimestampMicros != 5 {
		t.Fatalf("recovery pop = %+v, %t, %v", frame, ok, err)
	}
	queue.MarkRecoveryWritten(true)

	metrics := queue.Snapshot()
	if metrics.OverloadEvents != 1 || metrics.RecoveryKeyFrames != 1 ||
		metrics.CompletedRecoveries != 1 || metrics.DroppedFrames != 4 {
		t.Fatalf("unexpected recovery metrics: %+v", metrics)
	}
}

func TestFrameQueueFailsOnASecondOverloadBeforeRecoveryIsWritten(t *testing.T) {
	queue := newFrameQueue(1)
	defer queue.Close()

	pushFrame(t, queue, false, 1)
	result, err := queue.Push(testFrame(true, 2))
	if err != nil || !result.accepted || !result.requestKeyFrame {
		t.Fatalf("first overload result = %+v, %v", result, err)
	}
	_, err = queue.Push(testFrame(false, 3))
	if err == nil || !strings.Contains(err.Error(), "before key-frame recovery completed") {
		t.Fatalf("second overload error = %v", err)
	}
	if queue.Snapshot().UnrecoverableOverload != 1 {
		t.Fatalf("unrecoverable overload was not counted: %+v", queue.Snapshot())
	}
}

func TestFrameQueueCloseDiscardsBacklog(t *testing.T) {
	queue := newFrameQueue(2)
	pushFrame(t, queue, true, 1)
	pushFrame(t, queue, false, 2)
	queue.Close()

	_, ok, err := queue.Pop(context.Background())
	if err != nil || ok {
		t.Fatalf("closed queue pop = %t, %v; want no frame", ok, err)
	}
	metrics := queue.Snapshot()
	if metrics.ShutdownDroppedFrames != 2 || metrics.DroppedFrames != 2 {
		t.Fatalf("shutdown drops = %+v, want 2", metrics)
	}
}

func pushFrame(t *testing.T, queue *frameQueue, keyFrame bool, timestamp uint64) {
	t.Helper()
	result, err := queue.Push(testFrame(keyFrame, timestamp))
	if err != nil || !result.accepted {
		t.Fatalf("push frame %d = %+v, %v", timestamp, result, err)
	}
}

func testFrame(keyFrame bool, timestamp uint64) Frame {
	return Frame{
		KeyFrame:        keyFrame,
		TimestampMicros: timestamp,
		DurationMicros:  1,
		Data:            []byte{byte(timestamp)},
	}
}
