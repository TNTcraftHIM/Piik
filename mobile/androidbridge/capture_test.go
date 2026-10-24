package androidbridge

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

type testPlatform struct {
	mu      sync.Mutex
	stopped []int64
	started chan int64
}

func (*testPlatform) StartVideo(int64, string) {}
func (p *testPlatform) StartAudio(id int64) {
	if p.started != nil {
		p.started <- id
	}
}
func (*testPlatform) Control(int64, string, int64, int64) {}
func (p *testPlatform) Stop(id int64)                     { p.mu.Lock(); p.stopped = append(p.stopped, id); p.mu.Unlock() }

func TestRetiredCaptureUnblocksProducerAndCannotReachReplacement(t *testing.T) {
	p := &testPlatform{}
	c := &capture{platform: p, streams: make(map[int64]*captureStream)}
	r := &Runtime{capture: c}
	old := c.stream(context.Background(), nil)
	for range cap(old.frames) {
		old.push(nativecapture.Frame{Kind: nativecapture.FramePCM})
	}
	blocked := make(chan struct{})
	go func() { r.Audio(old.id, make([]byte, nativeaudio.FrameBytes)); close(blocked) }()
	old.Close()
	old.Close()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("retired capture left JNI producer blocked")
	}
	next := c.stream(context.Background(), nil)
	defer next.Close()
	r.Audio(old.id, make([]byte, nativeaudio.FrameBytes))
	if r.CaptureCurrent(old.id) || !r.CaptureCurrent(next.id) {
		t.Fatal("wrong capture generation retained")
	}
	select {
	case <-next.frames:
		t.Fatal("old callback reached replacement")
	default:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.stopped) != 1 || p.stopped[0] != old.id {
		t.Fatal("capture retirement was not once-only")
	}
}

func TestAudioProviderCommitsOnlyAfterPlatformStarted(t *testing.T) {
	p := &testPlatform{started: make(chan int64, 1)}
	c := &capture{platform: p, streams: make(map[int64]*captureStream)}
	r := &Runtime{capture: c}
	for _, success := range []bool{true, false} {
		done := make(chan error, 1)
		go func() {
			stream, err := c.Audio(context.Background(), nativecapture.CaptureTarget{}, nil)
			if stream != nil {
				stream.Close()
			}
			done <- err
		}()
		id := <-p.started
		select {
		case <-done:
			t.Fatal("audio returned before platform start")
		default:
		}
		if success {
			r.AudioReady(id)
		} else {
			r.CaptureEnded(id)
		}
		select {
		case err := <-done:
			if (err == nil) != success {
				t.Fatalf("audio success=%v err=%v", success, err)
			}
		case <-time.After(time.Second):
			t.Fatal("audio startup did not settle")
		}
		r.AudioReady(id)
		if r.CaptureCurrent(id) {
			t.Fatal("late ready revived retired audio")
		}
	}
}
