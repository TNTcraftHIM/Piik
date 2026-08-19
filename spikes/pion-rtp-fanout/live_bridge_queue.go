package fanoutoracle

import (
	"context"
	"errors"
	"sync"
)

type LiveQueueMetrics struct {
	Capacity         int `json:"capacity"`
	MaxDepth         int `json:"maxDepth"`
	AcceptedChunks   int `json:"acceptedChunks"`
	DroppedChunks    int `json:"droppedChunks"`
	OverloadEvents   int `json:"overloadEvents"`
	KeyFrameRequests int `json:"keyFrameRequests"`
}

type liveQueuePushResult struct {
	Accepted        bool
	RequestKeyFrame bool
}

// liveSampleQueue bounds the only application-owned media backlog. Once full,
// stale dependent frames are discarded and no new delta frame is admitted
// until a key frame restores a decodable boundary.
type liveSampleQueue struct {
	mu                    sync.Mutex
	items                 []encodedFrame
	capacity              int
	droppingUntilKeyFrame bool
	closed                bool
	notify                chan struct{}
	metrics               LiveQueueMetrics
}

func newLiveSampleQueue(capacity int) *liveSampleQueue {
	if capacity < 1 {
		panic("live sample queue capacity must be positive")
	}
	return &liveSampleQueue{
		capacity: capacity,
		notify:   make(chan struct{}, 1),
		metrics:  LiveQueueMetrics{Capacity: capacity},
	}
}

func (queue *liveSampleQueue) Push(frame encodedFrame) (liveQueuePushResult, error) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.closed {
		return liveQueuePushResult{}, errors.New("live sample queue is closed")
	}

	if queue.droppingUntilKeyFrame {
		if frame.Type != "key" {
			queue.metrics.DroppedChunks++
			return liveQueuePushResult{}, nil
		}
		queue.droppingUntilKeyFrame = false
	}

	requestKeyFrame := false
	if len(queue.items) >= queue.capacity {
		queue.metrics.DroppedChunks += len(queue.items)
		queue.metrics.OverloadEvents++
		queue.metrics.KeyFrameRequests++
		clear(queue.items)
		queue.items = queue.items[:0]
		queue.droppingUntilKeyFrame = true
		requestKeyFrame = true
		if frame.Type != "key" {
			queue.metrics.DroppedChunks++
			return liveQueuePushResult{RequestKeyFrame: true}, nil
		}
		queue.droppingUntilKeyFrame = false
	}

	queue.items = append(queue.items, frame)
	queue.metrics.AcceptedChunks++
	if len(queue.items) > queue.metrics.MaxDepth {
		queue.metrics.MaxDepth = len(queue.items)
	}
	queue.signal()
	return liveQueuePushResult{Accepted: true, RequestKeyFrame: requestKeyFrame}, nil
}

func (queue *liveSampleQueue) Pop(ctx context.Context) (encodedFrame, bool, error) {
	for {
		queue.mu.Lock()
		if len(queue.items) > 0 {
			frame := queue.items[0]
			queue.items[0] = encodedFrame{}
			queue.items = queue.items[1:]
			queue.mu.Unlock()
			return frame, true, nil
		}
		if queue.closed {
			queue.mu.Unlock()
			return encodedFrame{}, false, nil
		}
		queue.mu.Unlock()

		select {
		case <-queue.notify:
		case <-ctx.Done():
			return encodedFrame{}, false, ctx.Err()
		}
	}
}

func (queue *liveSampleQueue) Close() {
	queue.mu.Lock()
	queue.closed = true
	queue.mu.Unlock()
	queue.signal()
}

func (queue *liveSampleQueue) Snapshot() LiveQueueMetrics {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	return queue.metrics
}

func (queue *liveSampleQueue) signal() {
	select {
	case queue.notify <- struct{}{}:
	default:
	}
}
