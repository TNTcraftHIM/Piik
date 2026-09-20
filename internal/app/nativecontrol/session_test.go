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
	"github.com/pion/webrtc/v4"
)

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
	session := New("", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	for _, reuse := range []bool{false, true} {
		request := receiveOfferRequest{Version: 9, ID: "request_offer", Type: "receive-offer", ShareID: "viewer_session",
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

func TestMain(tests *testing.M) {
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
	os.Exit(tests.Run())
}

func runQuietCaptureFixture(directory string) {
	arguments, _ := json.Marshal(os.Args[1:])
	if err := os.WriteFile(filepath.Join(directory, "arguments.json"), arguments, 0600); err != nil {
		os.Exit(1)
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

func TestCaptureBorderPreferenceFollowsSourceAndProfile(t *testing.T) {
	for _, supported := range []bool{false, true} {
		t.Run(strconv.FormatBool(supported), func(t *testing.T) {
			directory := t.TempDir()
			t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", directory)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			session := New(executable, nativecapture.Capabilities{VideoCapture: true, SoftwareVP8: true, CaptureBorderControl: supported}, false)
			t.Cleanup(func() { _ = session.Close() })
			handle := func(request any) {
				t.Helper()
				payload, err := json.Marshal(request)
				if err != nil {
					t.Fatal(err)
				}
				value, err := session.Handle(t.Context(), payload)
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
			start := startShareRequest{Version: 9, ID: "request_start", Type: "start-share", ShareID: "share_123456",
				Source:            nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"},
				ShowCaptureBorder: true, EdgeCapacity: 1, Codec: "vp8",
				Profile: qualitySettings{Resolution: "1080p", MaxFramerate: 30, MaxBitrate: 5_000_000, DegradationPreference: "balanced"}}
			handle(start)
			assertBorder(supported)
			profile := start.Profile
			profile.Resolution = "480p"
			handle(updateShareRequest{Version: 9, ID: "request_update", Type: "update-share", ShareID: start.ShareID, Profile: profile})
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
				handle(replaceShareSourceRequest{Version: 9, ID: "request_replace", Type: "replace-share-source", ShareID: start.ShareID,
					Source: nativecapture.CaptureTarget{Kind: "display", SourceID: "2", Title: "Other fixture"}, ShowCaptureBorder: show})
				assertBorder(show && supported)
			}
			handle(stopShareRequest{Version: 9, ID: "request_stop", Type: "stop-share", ShareID: start.ShareID})
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
			session := New(executable, nativecapture.Capabilities{SoftwareVP8: true}, false)
			t.Cleanup(func() { _ = session.Close() })
			handle := func(payload string) any {
				t.Helper()
				value, err := session.Handle(t.Context(), []byte(payload))
				if err != nil {
					t.Fatal(err)
				}
				return value
			}
			const start = `{"version":9,"id":"request_start","type":"start-share","shareId":"share_123456","source":{"kind":"display","sourceId":"1","title":"Fixture"},"audio":false,"adapterIndex":0,"encoderIndex":0,"edgeCapacity":1,"codec":"vp8","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced"}}`
			handle(start)
			const update = `{"version":9,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":"720p","maxFramerate":30,"maxBitrate":3000000,"degradationPreference":"balanced"}}`
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
				`{"version":9,"id":"request_replace","type":"replace-share-source","shareId":"share_123456","source":{"kind":"display","sourceId":"1","title":"Fixture"},"audio":false,"adapterIndex":0,"encoderIndex":0}`,
			} {
				if _, ok := handle(payload).(requestFailedResponse); !ok {
					t.Fatal("conflicting capture mutation was not rejected")
				}
			}
			for _, payload := range []string{
				`{"version":9,"id":"request_pause","type":"pause-share","shareId":"share_123456","paused":true}`,
				`{"version":9,"id":"request_ice","type":"edge-candidate","shareId":"share_123456","connectionId":"retired_edge","candidate":null}`,
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
				handle(`{"version":9,"id":"request_stop","type":"stop-share","shareId":"share_123456"}`)
				if _, ok := handle(strings.ReplaceAll(start, "share_123456", "share_restart")).(shareStartedResponse); !ok {
					t.Fatal("stopped update blocked a new share")
				}
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
					value, err := session.Handle(t.Context(), []byte(`{"version":9,"id":"request_stop","type":"stop-share","shareId":"share_123456"}`))
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
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	for _, payload := range []string{
		`{"version":9,"id":"request_sources","type":"list-sources","extra":true}`,
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
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":9,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567"}`
	assertOperationFailure(t, session, valid)
	invalid := `{"version":9,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567","iceServers":[]}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil || err.Error() != "native prepare-local-edge request is invalid" {
		t.Fatalf("extended local-edge request was accepted: %v", err)
	}
}

func TestPreviewFailureReturnsAnAdvisoryResponse(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":9,"id":"request_preview","type":"source-preview","source":{"kind":"display","sourceId":"65537","title":"Display 1"}}`,
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
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":9,"id":"request_sources","type":"list-sources"}`,
	))
	if err != nil || value != operationFailure(requestEnvelope{
		Version: loopback.ProtocolVersion, ID: "request_sources", Type: "list-sources",
	}) {
		t.Fatalf("source list failure ended its control session: %#v, %v", value, err)
	}
	if _, err := session.Handle(t.Context(), []byte(
		`{"version":9,"id":"request_options","type":"capture-options"}`,
	)); err != nil {
		t.Fatalf("control was unusable after source enumeration failed: %v", err)
	}
}

func TestQualitySettingsMapOnceIntoNativeMedia(t *testing.T) {
	settings := qualitySettings{
		Resolution: "1440p", MaxFramerate: 60, MaxBitrate: 12_000_000,
		DegradationPreference: "maintain-framerate",
		ScreenAudioQuality:    "very-high",
	}
	profile := nativeQualityProfile(settings)
	if !validQualitySettings(settings) || profile.Video.Width != 2560 ||
		profile.Video.Height != 1440 || profile.Video.Framerate != 60 ||
		profile.Video.Bitrate != 12_000_000 ||
		profile.Video.Preference != "maintain-framerate" ||
		profile.AudioBitrate != 192_000 {
		t.Fatalf("native profile = %+v", profile)
	}
	settings.Resolution = "2160p"
	if validQualitySettings(settings) {
		t.Fatal("unsupported resolution was accepted")
	}
}

func TestUpdateShareRequiresTheCurrentStrictProfile(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":9,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","screenAudioQuality":"music"}}`
	assertOperationFailure(t, session, valid)
	invalid := `{"version":9,"id":"request_update","type":"update-share","shareId":"share_123456","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced","screenAudioQuality":"music","extra":true}}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil ||
		err.Error() != "native update-share request is invalid" {
		t.Fatalf("extended update was accepted: %v", err)
	}
}

func TestReplaceShareSourceKeepsOneStrictTargetShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":9,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0}`
	assertOperationFailure(t, session, valid)
	invalid := `{"version":9,"id":"request_source","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Portal"},"audio":false,"adapterIndex":0,"encoderIndex":0,"extra":true}`
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
