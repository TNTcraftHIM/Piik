package nativehost

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
)

func audioRecoveryProfile() nativecapture.VideoProfile {
	return nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30,
		Bitrate: 2_000_000, Preference: "balanced"}
}

// The same stable test executable supplies framed video and PCM, without a
// capture device. Closing stdin ends either child independently.
func runAudioRecoveryCapture() {
	stopped := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(stopped) }()
	write := func(frame nativecapture.Frame) {
		var header [32]byte
		copy(header[:], "SMED")
		header[4], header[5], header[7] = 2, byte(frame.Kind), byte(frame.Layer)
		if frame.KeyFrame {
			header[6] = 1
		}
		binary.BigEndian.PutUint64(header[8:16], uint64(frame.Timestamp/(100*time.Nanosecond)))
		binary.BigEndian.PutUint64(header[16:24], uint64(frame.Duration/(100*time.Nanosecond)))
		binary.BigEndian.PutUint16(header[24:26], uint16(frame.Width))
		binary.BigEndian.PutUint16(header[26:28], uint16(frame.Height))
		binary.BigEndian.PutUint32(header[28:32], uint32(len(frame.Data)))
		if _, err := os.Stdout.Write(append(header[:], frame.Data...)); err != nil {
			os.Exit(1)
		}
	}
	audio := len(os.Args) > 1 && os.Args[1] == "--capture-audio"
	period := time.Second / 30
	status := []byte(`{"state":"active","audio":true}`)
	if audio {
		period = 20 * time.Millisecond
	} else {
		outputs := nativecapture.ScreenShareOutputs(audioRecoveryProfile())
		outputs = append(outputs, outputs[0])
		status, _ = json.Marshal(CaptureState{State: "active", Codec: "vp8",
			Width: 1280, Height: 720, FPS: 30, Outputs: outputs})
	}
	write(nativecapture.Frame{Kind: nativecapture.FrameStatus, Data: status})
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for pts := period; ; pts += period {
		select {
		case <-stopped:
			return
		case <-ticker.C:
		}
		if audio {
			write(nativecapture.Frame{Kind: nativecapture.FramePCM, Timestamp: pts,
				Duration: period, Data: make([]byte, nativeaudio.FrameBytes)})
			continue
		}
		write(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: pts, Duration: period})
		for layer := range 2 {
			write(nativecapture.Frame{Kind: nativecapture.FrameVP8, Layer: layer, Width: 8, Height: 8,
				Timestamp: pts, Duration: period, KeyFrame: true, Data: sfu.VP8KeyFrame8x8})
		}
	}
}

func TestAudioEOFWaitsForExplicitSourceReplacement(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	executable, err := os.Executable()
	check(err)
	events := make(chan Event, 64)
	options := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
		Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Audio fixture"}}
	session, err := Start(ctx, Options{ShareID: "audio-recovery", CaptureProcess: executable,
		Video: options, Profile: QualityProfile{Video: options.Profile, AudioBitrate: 64_000},
		AudioEnabled: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0", Events: events})
	check(err)
	defer session.Close()
	if !session.HasAudio() {
		t.Fatal("fixture did not start audio")
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	receiver, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var audioPackets, videoPackets atomic.Uint64
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if track.Codec().MimeType == webrtc.MimeTypeOpus && len(packet.Payload) > 0 {
				audioPackets.Add(1)
			} else if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoPackets.Add(1)
			}
		}
	})
	offer, err := session.PrepareLocalEdge("audio-edge")
	check(err)
	check(receiver.SetRemoteDescription(offer))
	go func() {
		for {
			select {
			case event := <-events:
				if event.Type == "edge-candidate" && event.Candidate != nil {
					_ = receiver.AddICECandidate(*event.Candidate)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	gathered := webrtc.GatheringCompletePromise(receiver)
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("receiver gathering timed out")
	}
	check(session.SetAnswer("audio-edge", *receiver.LocalDescription()))
	waitPackets := func(counter *atomic.Uint64, minimum uint64, label string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for counter.Load() < minimum {
			if time.Now().After(deadline) {
				t.Fatalf("%s: received %d, wanted %d", label, counter.Load(), minimum)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitPackets(&audioPackets, 3, "initial Opus")
	waitPackets(&videoPackets, 3, "initial video")
	previousAudio, previousVideo := session.currentAudioStream(), session.currentStream()
	edge, audioSource := session.edge("audio-edge"), session.audioSource
	check(previousAudio.Close())
	waitPackets(&videoPackets, videoPackets.Load()+10, "video after audio EOF")
	before := audioPackets.Load()
	options.Target.SourceID = "2"
	check(session.ReplaceSource(ctx, options, true))
	if session.currentStream() == previousVideo || session.currentAudioStream() == previousAudio ||
		session.edge("audio-edge") != edge || session.audioSource != audioSource {
		t.Fatal("explicit replacement did not preserve the media owners")
	}
	waitPackets(&audioPackets, before+3, "Opus after explicit source replacement")
	check(session.currentAudioStream().Close())
	waitPackets(&videoPackets, videoPackets.Load()+5, "video after second audio EOF")
	closed := make(chan error, 1)
	go func() { closed <- session.Close() }()
	select {
	case err = <-closed:
		check(err)
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not unblock the audio replacement wait")
	}
}
