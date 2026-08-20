package media

import (
	"context"
	"errors"
	"sync"
)

type QueueMetrics struct {
	Capacity              int    `json:"capacity"`
	Depth                 int    `json:"depth"`
	MaxDepth              int    `json:"maxDepth"`
	AcceptedFrames        uint64 `json:"acceptedFrames"`
	DroppedFrames         uint64 `json:"droppedFrames"`
	ShutdownDroppedFrames uint64 `json:"shutdownDroppedFrames"`
	OverloadEvents        uint64 `json:"overloadEvents"`
	RecoveryKeyFrames     uint64 `json:"recoveryKeyFrames"`
	CompletedRecoveries   uint64 `json:"completedRecoveries"`
	UnrecoverableOverload uint64 `json:"unrecoverableOverload"`
}

type queuePushResult struct {
	accepted        bool
	requestKeyFrame bool
}

// frameQueue owns the only helper-side media backlog. After an overload it
// discards dependent frames until a key frame restores a decodable boundary.
type frameQueue struct {
	mu                    sync.Mutex
	items                 []Frame
	capacity              int
	droppingUntilKeyFrame bool
	recoveryPending       bool
	closed                bool
	notify                chan struct{}
	metrics               QueueMetrics
}

func newFrameQueue(capacity int) *frameQueue {
	if capacity < 1 {
		panic("frame queue capacity must be positive")
	}
	return &frameQueue{
		capacity: capacity,
		notify:   make(chan struct{}, 1),
		metrics:  QueueMetrics{Capacity: capacity},
	}
}

func (queue *frameQueue) Push(frame Frame) (queuePushResult, error) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.closed {
		return queuePushResult{}, errors.New("encoded media queue is closed")
	}

	if queue.droppingUntilKeyFrame {
		if !frame.KeyFrame {
			queue.metrics.DroppedFrames++
			return queuePushResult{}, nil
		}
		queue.droppingUntilKeyFrame = false
	}

	requestKeyFrame := false
	if len(queue.items) >= queue.capacity {
		if queue.recoveryPending {
			queue.metrics.UnrecoverableOverload++
			return queuePushResult{}, errors.New("encoded media queue overloaded before key-frame recovery completed")
		}
		queue.metrics.DroppedFrames += uint64(len(queue.items))
		queue.metrics.OverloadEvents++
		queue.metrics.RecoveryKeyFrames++
		clear(queue.items)
		queue.items = queue.items[:0]
		queue.droppingUntilKeyFrame = true
		queue.recoveryPending = true
		requestKeyFrame = true
		if !frame.KeyFrame {
			queue.metrics.DroppedFrames++
			return queuePushResult{requestKeyFrame: true}, nil
		}
		queue.droppingUntilKeyFrame = false
	}

	frame.Data = append([]byte(nil), frame.Data...)
	queue.items = append(queue.items, frame)
	queue.metrics.AcceptedFrames++
	if len(queue.items) > queue.metrics.MaxDepth {
		queue.metrics.MaxDepth = len(queue.items)
	}
	queue.signal()
	return queuePushResult{accepted: true, requestKeyFrame: requestKeyFrame}, nil
}

func (queue *frameQueue) Pop(ctx context.Context) (Frame, bool, error) {
	for {
		queue.mu.Lock()
		if len(queue.items) > 0 {
			frame := queue.items[0]
			queue.items[0] = Frame{}
			queue.items = queue.items[1:]
			queue.mu.Unlock()
			return frame, true, nil
		}
		if queue.closed {
			queue.mu.Unlock()
			return Frame{}, false, nil
		}
		queue.mu.Unlock()

		select {
		case <-queue.notify:
		case <-ctx.Done():
			return Frame{}, false, ctx.Err()
		}
	}
}

func (queue *frameQueue) MarkRecoveryWritten(keyFrame bool) {
	if !keyFrame {
		return
	}
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.recoveryPending {
		queue.recoveryPending = false
		queue.metrics.CompletedRecoveries++
	}
}

func (queue *frameQueue) Close() {
	queue.mu.Lock()
	queue.metrics.ShutdownDroppedFrames += uint64(len(queue.items))
	queue.metrics.DroppedFrames += uint64(len(queue.items))
	clear(queue.items)
	queue.items = nil
	queue.closed = true
	queue.mu.Unlock()
	queue.signal()
}

func (queue *frameQueue) Snapshot() QueueMetrics {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	metrics := queue.metrics
	metrics.Depth = len(queue.items)
	return metrics
}

func (queue *frameQueue) signal() {
	select {
	case queue.notify <- struct{}{}:
	default:
	}
}
