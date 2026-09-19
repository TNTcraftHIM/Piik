package nativehost

import (
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

func TestMixPCMRetainsSourceGainAndSaturatesStereo(t *testing.T) {
	frame := func(value int16) []byte {
		data := make([]byte, nativeaudio.FrameBytes)
		for i := 0; i < len(data); i += 2 {
			binary.LittleEndian.PutUint16(data[i:], uint16(value))
		}
		return data
	}
	output := frame(0)
	mixPCM(output, frame(1000), nil, 0, 0)
	if int16(binary.LittleEndian.Uint16(output)) != 1000 {
		t.Fatal("source was attenuated")
	}
	mixPCM(output, frame(1000), frame(2000), 0, 2)
	if binary.LittleEndian.Uint16(output[:2]) != binary.LittleEndian.Uint16(output[2:4]) ||
		int16(binary.LittleEndian.Uint16(output[len(output)-2:])) != 5000 ||
		int16(binary.LittleEndian.Uint16(output)) >= 1100 {
		t.Fatal("stereo gain did not ramp")
	}
	for _, value := range []int16{-30000, 30000} {
		mixPCM(output, frame(value), frame(value), 2, 2)
		expected := int16(32767)
		if value < 0 {
			expected = -32768
		}
		if int16(binary.LittleEndian.Uint16(output)) != expected {
			t.Fatal("sum wrapped instead of saturating")
		}
	}
	mixPCM(output, nil, nil, 2, 0)
	for _, value := range output {
		if value != 0 {
			t.Fatal("missing input replayed old audio")
		}
	}
	input := &audioInput{}
	for i := byte(0); i < 10; i++ {
		input.push([]byte{i})
	}
	for i := byte(6); i < 10; i++ {
		if got := input.pop(); len(got) != 1 || got[0] != i {
			t.Fatal("FIFO retained stale frames")
		}
	}
	if input.pop() != nil {
		t.Fatal("FIFO replayed the last sample")
	}
}

func startMixedFixture(t *testing.T) (*Session, nativecapture.VideoOptions, <-chan Event) {
	t.Helper()
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	events := make(chan Event, 64)
	options := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
		Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Mixed fixture"}}
	session, err := Start(ctx, Options{ShareID: "mixed_fixture", CaptureProcess: executable, Video: options,
		Profile: QualityProfile{Video: options.Profile, AudioBitrate: 64000}, MicrophoneMixing: true,
		EdgeCapacity: 1, BindAddress: "127.0.0.1:0", Events: func(_ context.Context, event Event) {
			select {
			case events <- event:
			case <-ctx.Done():
			}
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session, options, events
}

func TestNativeMicrophonePreservesMediaOwnersAcrossInputChanges(t *testing.T) {
	session, options, events := startMixedFixture(t)
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	if !session.HasAudio() || session.SourceAudio() == nil || *session.SourceAudio() {
		t.Fatal("silent mixed output was not reserved independently of source")
	}
	_, err := session.PrepareLocalEdge("mixed_edge")
	check(err)
	edge, source := session.edge("mixed_edge"), session.audioSource
	enabled, gain := true, 1.0
	check(session.SetMicrophone(&enabled, &gain, nil))
	session.mixer.mu.Lock()
	microphone := session.mixer.microphone
	session.mixer.mu.Unlock()
	if microphone == nil {
		t.Fatal("microphone did not start")
	}
	device := "missing"
	if session.SetMicrophone(nil, nil, &device) == nil {
		t.Fatal("missing microphone accepted")
	}
	session.mixer.mu.Lock()
	retained := session.mixer.microphone == microphone
	session.mixer.mu.Unlock()
	if !retained {
		t.Fatal("failed device switch retired healthy microphone")
	}
	device = "headset"
	check(session.SetMicrophone(nil, nil, &device))
	session.mixer.mu.Lock()
	replaced := session.mixer.microphone
	session.mixer.mu.Unlock()
	if replaced == nil || replaced == microphone || session.audioSource != source || session.edge("mixed_edge") != edge {
		t.Fatal("device change failed to replace only the input")
	}
	microphone = replaced
	options.Target.SourceID = "2"
	check(session.ReplaceSource(t.Context(), options, true))
	session.mixer.mu.Lock()
	sameMicrophone := session.mixer.microphone == microphone
	session.mixer.mu.Unlock()
	if !sameMicrophone || session.audioSource != source || session.edge("mixed_edge") != edge || !*session.SourceAudio() {
		t.Fatal("source replacement rebuilt microphone/output/edge")
	}
	session.SetPaused(true)
	time.Sleep(60 * time.Millisecond)
	session.mixer.mu.Lock()
	queued := len(session.mixer.source.frames) + len(session.mixer.microphone.frames)
	session.mixer.mu.Unlock()
	if queued != 0 {
		t.Fatal("paused speech accumulated")
	}
	session.SetPaused(false)
	// EOF retires only the microphone; source and all negotiated media stay live.
	check(microphone.stream.Close())
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event.Type != "audio-state" || !event.Failed {
				continue
			}
			if event.Microphone || !event.SourceAudio || !session.HasAudio() || session.edge("mixed_edge") != edge {
				t.Fatal("input loss damaged healthy media")
			}
			enabled = false
			check(session.SetMicrophone(&enabled, nil, nil))
			return
		case <-timer.C:
			t.Fatal("microphone loss was not reported")
		}
	}
}

func TestStopCancelsPendingMicrophoneWithoutRevivingShare(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "microphone-started")
	t.Setenv("PIIK_MICROPHONE_WAIT", marker)
	session, _, _ := startMixedFixture(t)
	result := make(chan error, 1)
	go func() { enabled := true; result <- session.SetMicrophone(&enabled, nil, nil) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("microphone fixture did not start")
		}
		time.Sleep(time.Millisecond)
	}
	stopped := make(chan error, 1)
	go func() { stopped <- session.Close() }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("microphone permission blocked Stop")
	}
	if err := <-result; err == nil {
		t.Fatal("late microphone became live after Stop")
	}
	session.mixer.mu.Lock()
	defer session.mixer.mu.Unlock()
	if session.mixer.microphone != nil {
		t.Fatal("retired microphone retained")
	}
}

func TestCancelledMixerCannotRegisterReplacementReader(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	mix := &audioMix{ctx: ctx}
	mix.setSource(&nativecapture.Stream{})
	if mix.source != nil {
		t.Fatal("cancelled mixer installed a source")
	}
	mix.readers.Wait()
}

func TestAudioNotificationBackpressureDoesNotBlockPauseOrGain(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	entered, returned := make(chan struct{}), make(chan struct{})
	input := &audioInput{}
	mix := &audioMix{ctx: ctx, microphone: input, emit: func(Event) { close(entered); <-ctx.Done() }}
	go func() { mix.inputEnded(input, true); close(returned) }()
	<-entered
	controlled := make(chan struct{})
	go func() {
		mix.setPaused(true)
		gain := 1.5
		if err := mix.setMicrophone("", nil, &gain, nil); err != nil {
			t.Error(err)
		}
		close(controlled)
	}()
	select {
	case <-controlled:
	case <-time.After(time.Second):
		t.Fatal("notifications blocked the control reader before Stop")
	}
	cancel()
	<-returned
}
