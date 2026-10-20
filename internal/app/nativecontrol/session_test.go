package nativecontrol

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativehost"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/webrtc/v4"
)

// Production responses may arrive through Events while the command loop keeps
// processing ICE, ping and stop. Tests wait only for this exact request ID.
func deliveredControlValue(value any) any {
	if event, ok := value.(loopback.ControlEvent); ok {
		if event.Current != nil && !event.Current() {
			return nil
		}
		if event.BeforeWrite != nil {
			event.BeforeWrite()
		}
		return event.Value
	}
	return value
}

func awaitControlResponse(t *testing.T, session *Session, payload []byte) (any, error) {
	t.Helper()
	value, err := session.Handle(t.Context(), payload)
	if value != nil || err != nil {
		return value, err
	}
	var request requestEnvelope
	if err := json.Unmarshal(payload, &request); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case value := <-session.Events():
			value = deliveredControlValue(value)
			encoded, _ := json.Marshal(value)
			var envelope responseEnvelope
			_ = json.Unmarshal(encoded, &envelope)
			if envelope.ID == request.ID {
				return value, nil
			}
		case <-deadline.C:
			t.Fatalf("request %s lost its response", request.ID)
		}
	}
}

func TestReceiveOfferReusePreservesLegacyResponseShape(t *testing.T) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	if _, err = peer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	session := New("", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	for _, reuse := range []bool{false, true} {
		request := receiveOfferRequest{Version: 10, ID: "request_offer", Type: "receive-offer", ShareID: "viewer_session",
			ConnectionID: "connection_1234", EdgeCapacity: 2, SDP: offer.SDP, ReuseReceiver: reuse}
		payload, _ := json.Marshal(request)
		value, err := session.Handle(t.Context(), payload)
		if err != nil {
			t.Fatal(err)
		}
		answer, ok := value.(receiveAnswerResponse)
		if !ok {
			t.Fatalf("receive offer returned %#v", value)
		}
		encoded, _ := json.Marshal(answer)
		if bytes.Contains(encoded, []byte(`"reused"`)) != reuse {
			t.Fatalf("new response field leaked across opt-in: %s", encoded)
		}
		if reuse && (answer.Reused == nil || !*answer.Reused) {
			t.Fatal("opted-in answer did not retain its receiver")
		}
	}
}

func TestRemoteStopShortcutRequiresAnOwnedShare(t *testing.T) {
	session := New("", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	for _, command := range []string{"get-remote-stop-shortcut", "set-remote-stop-shortcut"} {
		key := 0
		if command == "set-remote-stop-shortcut" {
			key = 9
		}
		request := remoteStopShortcutRequest{requestEnvelope: requestEnvelope{10, "request_shortcut", command}, ShareID: "retired_share", Key: key}
		payload, _ := json.Marshal(request)
		result, err := session.Handle(t.Context(), payload)
		if _, ok := result.(requestFailedResponse); !ok || err != nil {
			t.Fatalf("missing share must fail the operation, not the connection: %#v, %v", result, err)
		}
	}
}

func TestMain(tests *testing.M) {
	if path := os.Getenv("PIIK_SOURCE_LIST_FIXTURE"); path != "" {
		payload, err := os.ReadFile(path)
		if err != nil {
			os.Exit(1)
		}
		_, _ = os.Stdout.Write(payload)
		os.Exit(0)
	}
	if marker := os.Getenv("PIIK_SOURCE_PROBE_FIXTURE"); marker != "" {
		if err := os.WriteFile(marker, nil, 0600); err != nil {
			os.Exit(1)
		}
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}
	if directory := os.Getenv("PIIK_QUIET_CAPTURE_FIXTURE"); directory != "" {
		runQuietCaptureFixture(directory)
		os.Exit(0)
	}
	// Self-exec capture fixtures inherit this before their race runtime starts.
	// Real native helpers have no race detector's default one-second exit sleep.
	if err := os.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0"); err != nil {
		panic(err)
	}
	os.Exit(tests.Run())
}

func TestSourceListFitsTheControlEnvelope(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		title string
		count int
	}{
		{strings.Repeat("界", 512), 64},
		{strings.Repeat("<", 512), 100},
	} {
		targets := make([]nativecapture.CaptureTarget, check.count)
		for index := range targets {
			targets[index] = nativecapture.CaptureTarget{Kind: "window", SourceID: strconv.Itoa(index + 1),
				PID: 1, CreationTime: "1", Title: check.title}
		}
		var payload bytes.Buffer
		encoder := json.NewEncoder(&payload)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(targets); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "sources.json")
		if err := os.WriteFile(path, payload.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PIIK_SOURCE_LIST_FIXTURE", path)
		session := New(executable, nativecapture.Capabilities{}, false, nil)
		defer session.Close()
		value, err := awaitControlResponse(t, session,
			[]byte(`{"version":10,"id":"request_sources","type":"list-sources"}`))
		if err != nil {
			t.Fatal(err)
		}
		response, ok := value.(sourceListResponse)
		if !ok || len(response.Sources) == 0 {
			t.Fatalf("usable sources were lost: %#v", value)
		}
		if check.count == 64 && len(response.Sources) != 64 {
			t.Fatalf("localized windows were truncated: %d", len(response.Sources))
		}
		encoded, err := json.Marshal(response)
		if err != nil || len(encoded) > loopback.MaxControlMessageBytes {
			t.Fatalf("valid enumeration would close control: %d bytes, %v", len(encoded), err)
		}
	}
}

func runQuietCaptureFixture(directory string) {
	arguments, _ := json.Marshal(os.Args[1:])
	if err := os.WriteFile(filepath.Join(directory, "arguments.json"), arguments, 0600); err != nil {
		os.Exit(1)
	}
	if os.Getenv("PIIK_PENDING_CAPTURE_FIXTURE") == "true" {
		_ = os.WriteFile(filepath.Join(directory, "prepared"), nil, 0600)
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	var state nativehost.CaptureState
	state.State, state.Codec = "starting", "vp8"
	var adapter uint32
	state.AdapterIndex = &adapter
	state.AdapterName, state.AdapterIdentity, state.EncoderName, state.EncoderIdentity = "fixture", "fixture", "fixture", "fixture"
	number := func(value string) uint32 { parsed, _ := strconv.ParseUint(value, 10, 32); return uint32(parsed) }
	for index := 1; index < len(os.Args)-1; index++ {
		switch os.Args[index] {
		case "--width":
			state.Width = number(os.Args[index+1])
		case "--height":
			state.Height = number(os.Args[index+1])
		case "--fps":
			state.FPS = number(os.Args[index+1])
		case "--output":
			state.Outputs = append(state.Outputs, nativecapture.OutputProfile{Width: number(os.Args[index+1]),
				Height: number(os.Args[index+2]), Framerate: number(os.Args[index+3]), Bitrate: number(os.Args[index+4])})
		}
	}
	write := func(kind nativecapture.FrameKind, payload []byte, timestamp uint64) {
		var header [32]byte
		copy(header[:], "SMED")
		header[4], header[5] = 2, byte(kind)
		if kind == nativecapture.FrameBegin {
			binary.BigEndian.PutUint64(header[8:16], timestamp)
			binary.BigEndian.PutUint64(header[16:24], 333_333)
		}
		binary.BigEndian.PutUint32(header[28:32], uint32(len(payload)))
		_, _ = os.Stdout.Write(header[:])
		_, _ = os.Stdout.Write(payload)
	}
	status := func() { payload, _ := json.Marshal(state); write(nativecapture.FrameStatus, payload, 0) }
	if len(os.Args) == 2 && os.Args[1] == "--capture-microphone" {
		write(nativecapture.FrameStatus, []byte(`{"state":"active","audio":true}`), 0)
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	status()
	closed := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(closed) }()
	if state.Width == 1280 {
		_ = os.WriteFile(filepath.Join(directory, "prepared"), nil, 0600)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var input uint64
		for {
			select {
			case <-closed:
				return
			case <-ticker.C:
				value, _ := os.ReadFile(filepath.Join(directory, "release"))
				if string(value) == "active" {
					write(nativecapture.FrameBegin, nil, input+333_333)
					state.State = "active"
					status()
					<-closed
					return
				}
				if string(value) == "input" {
					input += 333_333
					write(nativecapture.FrameBegin, nil, input)
				}
			}
		}
	}
	state.State = "active"
	status()
	<-closed
}

func TestMicrophoneOptInPreservesLegacyAndOrdersStateBeforeCompletion(t *testing.T) {
	for _, optIn := range []bool{false, true} {
		t.Run(strconv.FormatBool(optIn), func(t *testing.T) {
			t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", t.TempDir())
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			session := New(executable, nativecapture.Capabilities{VideoCapture: true, SoftwareVP8: true, Microphone: true}, false, nil)
			defer session.Close()
			request := startShareRequest{Version: 10, ID: "request_start", Type: "start-share", ShareID: "share_123456",
				Source:           nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"},
				MicrophoneMixing: optIn, EdgeCapacity: 1, Codec: "vp8",
				Profile: qualitySettings{Resolution: protocol.QualityResolution{Width: 1920, Height: 1080}, MaxFramerate: 30, MaxBitrate: 5_000_000, DegradationPreference: "balanced"}}
			payload, _ := json.Marshal(request)
			result, err := awaitControlResponse(t, session, payload)
			started, ok := result.(shareStartedResponse)
			if err != nil || !ok {
				t.Fatalf("start failed: %v %#v", err, result)
			}
			encoded, _ := json.Marshal(started)
			if started.Audio != optIn || bytes.Contains(encoded, []byte(`"sourceAudio"`)) != optIn {
				t.Fatalf("mixed output leaked across opt-in: %s", encoded)
			}
			result, err = session.Handle(t.Context(), []byte(`{"version":10,"id":"request_mic","type":"set-microphone","shareId":"share_123456","enabled":true,"volume":1}`))
			if !optIn {
				if _, failed := result.(requestFailedResponse); err != nil || !failed {
					t.Fatalf("non-opted share admitted mic: %v %#v", err, result)
				}
				return
			}
			if err != nil || result != nil {
				t.Fatalf("device setup was not asynchronous: %v %#v", err, result)
			}
			stateSeen := false
			for {
				select {
				case event := <-session.Events():
					event = deliveredControlValue(event)
					switch value := event.(type) {
					case audioStateEvent:
						stateSeen = value.Microphone && !value.SourceAudio
					case responseEnvelope:
						if value.Type == "microphone-set" {
							if !stateSeen {
								t.Fatal("completion overtook microphone state")
							}
							return
						}
					case requestFailedResponse:
						t.Fatalf("microphone failed: %#v", value)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("microphone did not complete")
				}
			}
		})
	}
}

func TestRemoteInputRequiresPageOptIn(t *testing.T) {
	for _, optIn := range []bool{false, true} {
		t.Run(strconv.FormatBool(optIn), func(t *testing.T) {
			t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", t.TempDir())
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			// No OS sink or approved controller: only exercise event ownership.
			session := New(executable, nativecapture.Capabilities{VideoCapture: true, SoftwareVP8: true}, false, &remoteinput.Manager{})
			defer session.Close()
			request := startShareRequest{Version: 10, ID: "request_start", Type: "start-share", ShareID: "share_123456",
				Source:      nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"},
				RemoteInput: optIn, EdgeCapacity: 1, Codec: "vp8",
				Profile: qualitySettings{Resolution: protocol.QualityResolution{Width: 1920, Height: 1080}, MaxFramerate: 30, MaxBitrate: 5_000_000, DegradationPreference: "balanced"}}
			payload, _ := json.Marshal(request)
			result, err := awaitControlResponse(t, session, payload)
			if _, ok := result.(shareStartedResponse); err != nil || !ok {
				t.Fatalf("start failed: %v %#v", err, result)
			}
			if (session.current(request.ShareID).RemoteInputChanges() != nil) != optIn {
				t.Fatal("input events did not respect page opt-in")
			}
			// Browser quality candidates relay through this same preview bridge.
			offer, err := session.current(request.ShareID).PrepareLocalEdge("preview_input", "preview_offer", false)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(offer.SDP, "m=application ") != optIn {
				t.Fatal("preview bridge did not preserve the opted-in input channel")
			}
		})
	}
}

func TestCaptureBorderPreferenceFollowsSourceAndProfile(t *testing.T) {
	for _, supported := range []bool{false, true} {
		t.Run(strconv.FormatBool(supported), func(t *testing.T) {
			directory := t.TempDir()
			t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", directory)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			session := New(executable, nativecapture.Capabilities{VideoCapture: true, SoftwareVP8: true, CaptureBorderControl: supported}, false, nil)
			t.Cleanup(func() { _ = session.Close() })
			handle := func(request any) {
				t.Helper()
				payload, err := json.Marshal(request)
				if err != nil {
					t.Fatal(err)
				}
				value, err := awaitControlResponse(t, session, payload)
				if _, failed := value.(requestFailedResponse); err != nil || failed {
					t.Fatalf("capture request failed: %v, %#v", err, value)
				}
			}
			assertBorder := func(expected bool) {
				t.Helper()
				data, err := os.ReadFile(filepath.Join(directory, "arguments.json"))
				var arguments []string
				if err != nil || json.Unmarshal(data, &arguments) != nil {
					t.Fatalf("capture arguments missing: %v", err)
				}
				if slices.Contains(arguments, "--show-capture-border") != expected {
					t.Fatalf("capture border intent lost: %v", arguments)
				}
			}
			start := startShareRequest{Version: 10, ID: "request_start", Type: "start-share", ShareID: "share_123456",
				Source:            nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"},
				ShowCaptureBorder: true, EdgeCapacity: 1, Codec: "vp8",
				Profile: qualitySettings{Resolution: protocol.QualityResolution{Width: 1920, Height: 1080}, MaxFramerate: 30, MaxBitrate: 5_000_000, DegradationPreference: "balanced"}}
			handle(start)
			assertBorder(supported)
			profile := start.Profile
			profile.Resolution = protocol.QualityResolution{Width: 854, Height: 480}
			handle(updateShareRequest{Version: 10, ID: "request_update", Type: "update-share", ShareID: start.ShareID, Profile: profile})
			session.mu.Lock()
			done := session.updateDone
			session.mu.Unlock()
			if done != nil {
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("profile update did not settle")
				}
			}
			assertBorder(supported)
			for _, show := range []bool{false, true} {
				handle(replaceShareSourceRequest{Version: 10, ID: "request_replace", Type: "replace-share-source", ShareID: start.ShareID,
					Source: nativecapture.CaptureTarget{Kind: "display", SourceID: "2", Title: "Other fixture"}, ShowCaptureBorder: show})
				assertBorder(show && supported)
			}
			handle(stopShareRequest{Version: 10, ID: "request_stop", Type: "stop-share", ShareID: start.ShareID})
		})
	}
}

func TestQuietHostUpdatePreservesControlAndCancelsCleanly(t *testing.T) {
	for _, outcome := range []string{"complete", "stop", "disconnect", "first-input-timeout", "backpressure-stop"} {
		t.Run(outcome, func(t *testing.T) {
			var trace bytes.Buffer
			if outcome == "complete" {
				previous := slog.Default()
				t.Cleanup(func() { slog.SetDefault(previous) })
				slog.SetDefault(slog.New(slog.NewJSONHandler(&trace, &slog.HandlerOptions{Level: slog.LevelDebug})))
			}
			directory := t.TempDir()
			t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", directory)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			session := New(executable, nativecapture.Capabilities{SoftwareVP8: true}, false, nil)
			t.Cleanup(func() { _ = session.Close() })
			handle := func(payload string) any {
				t.Helper()
				var value any
				var err error
				if strings.Contains(payload, `"type":"start-share"`) {
					value, err = awaitControlResponse(t, session, []byte(payload))
				} else {
					value, err = session.Handle(t.Context(), []byte(payload))
				}
				if err != nil {
					t.Fatal(err)
				}
				return value
			}
			const start = `{"version":10,"id":"request_start","type":"start-share","shareId":"share_123456","source":{"kind":"display","sourceId":"1","title":"Fixture"},"audio":false,"adapterIndex":0,"encoderIndex":0,"edgeCapacity":1,"codec":"vp8","profile":{"resolution":{"width":1920,"height":1080},"maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced"}}`
			handle(start)
			const update = `{"version":10,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":{"width":1280,"height":720},"maxFramerate":30,"maxBitrate":3000000,"degradationPreference":"balanced"}}`
			if value := handle(update); value != nil {
				t.Fatalf("Host update did not defer: %#v", value)
			}
			session.mu.Lock()
			done := session.updateDone
			session.mu.Unlock()
			deadline := time.Now().Add(2 * time.Second)
			for {
				if _, err = os.Stat(filepath.Join(directory, "prepared")); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("replacement did not reach its starting state")
				}
				time.Sleep(10 * time.Millisecond)
			}
			for _, payload := range []string{
				strings.Replace(update, "request_update", "request_duplicate", 1),
				`{"version":10,"id":"request_replace","type":"replace-share-source","shareId":"share_123456","source":{"kind":"display","sourceId":"1","title":"Fixture"},"audio":false,"adapterIndex":0,"encoderIndex":0}`,
			} {
				if _, ok := handle(payload).(requestFailedResponse); !ok {
					t.Fatal("conflicting capture mutation was not rejected")
				}
			}
			for _, payload := range []string{
				`{"version":10,"id":"request_pause","type":"pause-share","shareId":"share_123456","paused":true}`,
				`{"version":10,"id":"request_ice","type":"edge-candidate","shareId":"share_123456","connectionId":"retired_edge","candidate":null}`,
			} {
				started := time.Now()
				handle(payload)
				if time.Since(started) > time.Second {
					t.Fatal("quality preparation blocked control")
				}
			}
			switch outcome {
			case "complete":
				select {
				case <-done:
					t.Fatal("quiet source update ended before a frame arrived")
				case <-time.After(5200 * time.Millisecond):
				}
				if err = os.WriteFile(filepath.Join(directory, "release"), []byte("active"), 0600); err != nil {
					t.Fatal(err)
				}
			case "first-input-timeout":
				if err = os.WriteFile(filepath.Join(directory, "release"), []byte("input"), 0600); err != nil {
					t.Fatal(err)
				}
			case "backpressure-stop":
			fill:
				for {
					select {
					case session.events <- struct{}{}:
					default:
						break fill
					}
				}
				if err = os.WriteFile(filepath.Join(directory, "release"), []byte("active"), 0600); err != nil {
					t.Fatal(err)
				}
			case "stop":
				handle(`{"version":10,"id":"request_stop","type":"stop-share","shareId":"share_123456"}`)
			case "disconnect":
				if err = session.Close(); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-done:
			case <-time.After(6 * time.Second):
				t.Fatal("update did not finish after input or cancellation")
			}
			if outcome == "disconnect" {
				return
			}
			if outcome == "backpressure-stop" {
				stopped := make(chan any, 1)
				go func() {
					value, err := session.Handle(t.Context(), []byte(`{"version":10,"id":"request_stop","type":"stop-share","shareId":"share_123456"}`))
					if err != nil {
						stopped <- err
					} else {
						stopped <- value
					}
				}()
				select {
				case value := <-stopped:
					if _, ok := value.(responseEnvelope); !ok {
						t.Fatalf("backpressured stop failed: %#v", value)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("completion backpressure blocked stop")
				}
				return
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			responseFor := func(id string) any {
				for {
					select {
					case value := <-session.Events():
						value = deliveredControlValue(value)
						if response, ok := value.(shareUpdatedResponse); ok && response.ID == id {
							return value
						}
						if response, ok := value.(requestFailedResponse); ok && response.ID == id {
							return value
						}
					case <-ctx.Done():
						t.Fatal("deferred update lost its response")
					}
				}
			}
			_, success := responseFor("request_update").(shareUpdatedResponse)
			if success != (outcome == "complete") {
				t.Fatal("deferred response did not match capture outcome")
			}
			if outcome == "stop" {
				if _, ok := handle(strings.ReplaceAll(start, "share_123456", "share_restart")).(shareStartedResponse); !ok {
					t.Fatal("stopped update blocked a new share")
				}
			}
			if outcome == "complete" {
				if value := handle(strings.Replace(update, "request_update", "request_followup", 1)); value != nil {
					t.Fatal("acknowledged update still blocked its successor")
				}
				if _, ok := responseFor("request_followup").(shareUpdatedResponse); !ok {
					t.Fatal("later update could not complete")
				}
				_ = session.Close()
				var started, ended int
				decoder := json.NewDecoder(&trace)
				for decoder.More() {
					var record map[string]any
					if err := decoder.Decode(&record); err != nil {
						t.Fatal(err)
					}
					if record["requestId"] != "request_update" {
						continue
					}
					switch record["event"] {
					case "native-request-started":
						started++
					case "native-request-ended":
						ended++
						if record["durationMs"].(float64) < 5_000 || record["failed"] != false || record["share"] == "share_123456" {
							t.Fatalf("asynchronous request lost duration, outcome or private identity handling: %+v", record)
						}
					}
				}
				if started != 1 || ended != 1 {
					t.Fatalf("async update logged %d starts and %d completions", started, ended)
				}
			}
		})
	}
}

func TestSTUNURLsUseTheCurrentBoundedWire(t *testing.T) {
	servers, err := pionICEServers([]iceServer{{URLs: []string{
		"stun:example.test:3478",
		"stun:example.test:3479",
	}}})
	if err != nil || len(servers) != 1 || len(servers[0].URLs) != 2 {
		t.Fatalf("servers = %+v, %v", servers, err)
	}
	for _, value := range []string{
		"turn:example.com:3478",
		"stun:user@example.com:3478",
		"stun:example.com:0",
		"stun:example.com/path",
	} {
		if validSTUNURL(value) {
			t.Fatalf("invalid STUN URL accepted: %s", value)
		}
	}
}

func TestControlMessagesRejectUnknownFieldsAndStaleVersions(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	for _, payload := range []string{
		`{"version":10,"id":"request_sources","type":"list-sources","extra":true}`,
		`{"version":4,"id":"request_sources","type":"list-sources"}`,
		`{"version":5,"id":"short","type":"stop-share","shareId":"share_123456"}`,
	} {
		if _, err := session.Handle(t.Context(), []byte(payload)); err == nil {
			t.Fatalf("invalid control message accepted: %s", payload)
		}
	}
}

func TestResponseKeepsTheRequestIdentity(t *testing.T) {
	value := response(requestEnvelope{
		Version: loopback.ProtocolVersion,
		ID:      "request_123456",
		Type:    "stop-share",
	}, "share-stopped")
	if value.Version != loopback.ProtocolVersion || value.ID != "request_123456" ||
		value.Type != "share-stopped" {
		t.Fatalf("response = %+v", value)
	}
	failed := operationFailure(requestEnvelope{
		Version: loopback.ProtocolVersion, ID: "request_update", Type: "update-share",
	})
	if failed.Version != loopback.ProtocolVersion || failed.ID != "request_update" ||
		failed.Type != "request-failed" || failed.Code != "operation-failed" {
		t.Fatalf("operation failure lost its request identity: %+v", failed)
	}
}

func TestPrepareLocalEdgeOwnsOneStrictRequestShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":10,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567"}`
	assertOperationFailure(t, session, valid)
	invalid := `{"version":10,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567","iceServers":[]}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil || err.Error() != "native prepare-local-edge request is invalid" {
		t.Fatalf("extended local-edge request was accepted: %v", err)
	}
}

func TestPreviewFailureReturnsAnAdvisoryResponse(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":10,"id":"request_preview","type":"source-preview","source":{"kind":"display","sourceId":"65537","title":"Display 1"}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	response, ok := value.(sourcePreviewResponse)
	if !ok || response.Data != "" || response.SourceKey != "display:65537" {
		t.Fatalf("preview response = %#v", value)
	}
}

func TestSourceEnumerationFailureDoesNotCloseControl(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":10,"id":"request_sources","type":"list-sources"}`,
	))
	if err != nil || value != operationFailure(requestEnvelope{
		Version: loopback.ProtocolVersion, ID: "request_sources", Type: "list-sources",
	}) {
		t.Fatalf("source list failure ended its control session: %#v, %v", value, err)
	}
	if _, err := session.Handle(t.Context(), []byte(
		`{"version":10,"id":"request_options","type":"capture-options"}`,
	)); err != nil {
		t.Fatalf("control was unusable after source enumeration failed: %v", err)
	}
}

func TestQualitySettingsMapOnceIntoNativeMedia(t *testing.T) {
	settings := qualitySettings{
		Resolution: protocol.QualityResolution{Width: 2560, Height: 1440}, MaxFramerate: 60, MaxBitrate: 12_000_000,
		DegradationPreference: "maintain-framerate",
		MaxAudioBitrate:       192000,
	}
	profile := nativeQualityProfile(settings)
	if !profile.Valid() || profile.Video.Width != 2560 ||
		profile.Video.Height != 1440 || profile.Video.Framerate != 60 ||
		profile.Video.Bitrate != 12_000_000 ||
		profile.Video.Preference != "maintain-framerate" ||
		profile.AudioBitrate != 192_000 {
		t.Fatalf("native profile = %+v", profile)
	}
	settings.Resolution = protocol.QualityResolution{Width: 1920, Height: 1200}
	if profile := nativeQualityProfile(settings); !profile.Valid() || profile.Video.Height != 1200 {
		t.Fatalf("numeric size outside UI presets was not preserved: %+v", profile)
	}
	settings.Resolution = protocol.QualityResolution{Width: 3840, Height: 2160}
	if !nativeQualityProfile(settings).Valid() {
		t.Fatal("4K60 was rejected")
	}
	settings.MaxFramerate = 30
	if !nativeQualityProfile(settings).Valid() {
		t.Fatal("4K30 was rejected")
	}
	for _, fps := range []protocol.Num{30.5, 65, 120, 0x1_0000_0000 + 30} {
		settings.MaxFramerate = fps
		if nativeQualityProfile(settings).Valid() {
			t.Fatalf("unsupported fps %v was narrowed into a valid profile", fps)
		}
	}
}

func TestUpdateShareRequiresTheCurrentStrictProfile(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":10,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":{"width":1920,"height":1080},"maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","maxAudioBitrate":128000}}`
	assertOperationFailure(t, session, valid)
	// Opus permits this numeric request, but the current 20 ms sender does not.
	// Keep the control session usable and let the caller keep its current share.
	assertOperationFailure(t, session, strings.Replace(valid, `"maxAudioBitrate":128000`, `"maxAudioBitrate":510000`, 1))
	assertOperationFailure(t, session, strings.Replace(valid,
		`"resolution":{"width":1920,"height":1080}`,
		`"resolution":{"width":7680,"height":4320}`, 1))
	for _, replace := range [][2]string{
		{`"width":1920`, `"width":32768`}, {`"width":1920`, `"width":1921`},
		{`"maxFramerate":30`, `"maxFramerate":480`}, {`"maxFramerate":30`, `"maxFramerate":30.5`},
		{`"maxFramerate":30`, `"maxFramerate":4294967326`}, {`"maxFramerate":30`, `"maxFramerate":0.5`},
		{`"maxBitrate":5000000`, `"maxBitrate":240000001`}, {`"maxBitrate":5000000`, `"maxBitrate":1000`},
	} {
		assertOperationFailure(t, session, strings.Replace(valid, replace[0], replace[1], 1))
	}
	if _, err := session.Handle(t.Context(), []byte(`{"version":10,"id":"request_options","type":"capture-options"}`)); err != nil {
		t.Fatalf("unsupported media setting retired control: %v", err)
	}
	invalid := `{"version":10,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":{"width":1920,"height":1080},"maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","maxAudioBitrate":128000,"extra":true}}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native update-share request is invalid" {
		t.Fatalf("extended update was accepted: %v", err)
	}
}

func TestReplaceShareSourceKeepsOneStrictTargetShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false, nil)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":10,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0}`
	assertOperationFailure(t, session, valid)
	invalid := `{"version":10,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0,"extra":true}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native replace-share-source request is invalid" {
		t.Fatalf("extended source replacement was accepted: %v", err)
	}
	invalid = strings.Replace(valid, `"kind":"picker"`, `"kind":"unknown"`, 1)
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native replace-share-source request is invalid" {
		t.Fatalf("malformed target was treated as an operational failure: %v", err)
	}
}

func TestAudioExclusionValidatesScopeWithoutDroppingRequestedPolicy(t *testing.T) {
	session := &Session{capabilities: nativecapture.Capabilities{Microphone: true, SystemAudio: true, ProcessAudioExclusion: true}}
	display := nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Screen"}
	window := nativecapture.CaptureTarget{Kind: "window", SourceID: "2", PID: 123, CreationTime: "456", Title: "Voice fixture"}
	if err := session.validateAudioExclusion(display, true, &window); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []struct {
		source   nativecapture.CaptureTarget
		audio    bool
		excluded nativecapture.CaptureTarget
	}{
		{display, false, window}, {window, true, window}, {display, true, display},
		{display, true, nativecapture.CaptureTarget{Kind: "window", SourceID: "2", PID: 123, Title: "Missing lifetime"}},
	} {
		if _, ok := session.validateAudioExclusion(invalid.source, invalid.audio, &invalid.excluded).(protocolViolation); !ok {
			t.Fatal("malformed audio exclusion was not rejected")
		}
	}
	session.capabilities.ProcessAudioExclusion = false
	err := session.validateAudioExclusion(display, true, &window)
	if _, malformed := err.(protocolViolation); err == nil || malformed {
		t.Fatal("unsupported audio exclusion must fail the operation, not silently widen capture or close control")
	}
	if err := session.validateAudioExclusion(display, true, nil); err != nil {
		t.Fatal("legacy capture became dependent on exclusion support")
	}
}
