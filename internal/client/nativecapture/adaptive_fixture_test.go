package nativecapture

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
	"time"
)

// Opt-in real capture-process check; normal tests never start a codec or GPU.
func TestAdaptiveOutputFixture(t *testing.T) {
	executable, fixture := os.Getenv("SCREENER_NATIVE_CAPTURE"), os.Getenv("SCREENER_ADAPTIVE_INPUT")
	if executable == "" || fixture == "" {
		t.Skip("set SCREENER_NATIVE_CAPTURE and SCREENER_ADAPTIVE_INPUT")
	}
	codec := os.Getenv("SCREENER_ADAPTIVE_CODEC")
	if codec == "" {
		codec = "vp8"
	}
	kind := FrameVP8
	if codec == "h264" {
		kind = FrameH264
	}
	input, err := os.Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	var frames []Frame
	decoder := json.NewDecoder(input)
	for {
		var row struct {
			Width, Height uint32
			Recovery      bool
			DataHex       string
		}
		if err = decoder.Decode(&row); err == io.EOF {
			break
		}
		if err != nil || len(frames) >= 180 || len(row.DataHex) > maxMediaBytes*2 {
			t.Fatalf("invalid bounded input: %v", err)
		}
		data, err := hex.DecodeString(row.DataHex)
		if err != nil || row.Width != 640 || row.Height != 360 {
			t.Fatal("expected 640x360 encoded input")
		}
		frames = append(frames, Frame{Kind: kind, KeyFrame: row.Recovery,
			Width: row.Width, Height: row.Height, Data: data})
	}
	if len(frames) == 0 || !frames[0].KeyFrame {
		t.Fatal("input must begin with recovery")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 85*time.Second)
	defer cancel()
	stream, err := StartEncodedVideo(ctx, executable, EncodedVideoOptions{
		Codec: codec, Preference: "maintain-framerate",
		Outputs: []OutputProfile{{Width: 640, Height: 360, Framerate: 30, Bitrate: 2_000_000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if err = stream.SetOutputActive(0, true); err != nil {
		t.Fatal(err)
	}
	readDone := make(chan error, 1)
	timelineError := errors.New("adaptive output violated its input timeline")
	var output []Frame
	go func() {
		var begin, previous time.Duration
		for {
			frame, err := stream.Read()
			if err != nil {
				readDone <- err
				return
			}
			if frame.Kind == FrameBegin && begin == 0 {
				begin = frame.Timestamp
			}
			if frame.Kind == FrameLayerUnavailable {
				readDone <- errors.New("capture layer unavailable: " + string(frame.Data))
				return
			}
			if frame.Kind != kind {
				continue
			}
			if frame.Timestamp < begin || frame.Timestamp <= previous || len(output) >= 2400 {
				readDone <- timelineError
				return
			}
			previous = frame.Timestamp
			output = append(output, frame)
		}
	}()
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	for index := 0; index < 76*30; index++ {
		select {
		case err := <-readDone:
			t.Fatalf("capture stopped during adaptation: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
		if index == 6*30 || index == 21*30 {
			budget := uint32(100_000)
			if index == 21*30 {
				budget = 2_000_000
			}
			if err = stream.SetOutputBitrate(0, budget); err != nil {
				t.Fatal(err)
			}
		}
		frame := frames[index%len(frames)]
		// Preserve a non-microsecond-aligned input anchor through WebRTC.
		frame.Timestamp = time.Duration(index+1)*time.Second/30 + 100*time.Nanosecond
		frame.Duration = time.Second / 30
		if err = stream.WriteFrame(frame); err != nil {
			t.Fatal(err)
		}
	}
	if err = stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err = <-readDone; err == timelineError {
		t.Fatal(err)
	}
	var healthy, reduced, restored int
	type interval struct {
		Frames, Bytes int
		Width, Height uint32
	}
	intervals := make([]interval, 16)
	for _, frame := range output {
		window := &intervals[min(int(frame.Timestamp/(5*time.Second)), len(intervals)-1)]
		window.Frames++
		window.Bytes += len(frame.Data)
		window.Width, window.Height = frame.Width, frame.Height
		switch {
		case frame.Timestamp < 6*time.Second && frame.Width == 640:
			healthy++
		case frame.Timestamp >= 6*time.Second && frame.Timestamp < 21*time.Second && frame.Width < 640:
			reduced++
		case frame.Timestamp >= 21*time.Second && frame.Width == 640:
			restored++
		}
	}
	for index, window := range intervals {
		t.Logf("t=%ds frames=%d bytes=%d final=%dx%d", index*5, window.Frames, window.Bytes, window.Width, window.Height)
	}
	t.Logf("codec=%s healthy=%d reduced=%d restored=%d total=%d", codec, healthy, reduced, restored, len(output))
	if healthy == 0 || reduced == 0 || restored == 0 {
		t.Fatal("real output did not preserve delivery through adapt/recover")
	}
}
