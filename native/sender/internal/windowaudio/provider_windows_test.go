//go:build windows

package windowaudio

import (
	"context"
	"encoding/binary"
	"flag"
	"os"
	"testing"
	"time"
)

const testCreationTime = uint64(123456)

var (
	captureHelperPID = flag.String("capture", "", "run as the process-audio capture test helper")
	listHelper       = flag.Bool("list", false, "run as the process-audio list test helper")
)

func TestMain(main *testing.M) {
	flag.Parse()
	if *listHelper {
		_, _ = os.Stdout.Write(make([]byte, maxListBytes+1))
		select {}
	}
	if *captureHelperPID != "" {
		if len(flag.Args()) != 1 || flag.Args()[0] != "123456" {
			os.Exit(3)
		}
		header := make([]byte, helperHeaderSize)
		copy(header, "SPCM")
		header[4] = 1
		binary.BigEndian.PutUint64(header[16:24], 200_000)
		binary.BigEndian.PutUint32(header[24:28], 4)
		_, _ = os.Stdout.Write(header)
		_, _ = os.Stdout.Write(make([]byte, 4))
		_, _ = os.Stdout.Write(make([]byte, helperHeaderSize))
		select {}
	}
	os.Exit(main.Run())
}

func TestCapturePassesIdentityAndKillsHelperBeforeWaitingOnInvalidHeader(t *testing.T) {
	provider := &windowsProvider{helper: os.Args[0]}
	if !provider.available() {
		t.Skip("requires Windows 11")
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	chunks := 0
	go func() {
		result <- provider.Capture(ctx, Target{PID: 1, CreationTime: testCreationTime}, func(PCMChunk) error {
			chunks++
			return nil
		})
	}()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("Capture returned nil after an invalid helper header")
		}
		if chunks != 1 {
			t.Fatalf("Capture delivered %d chunks; process identity was not passed to the helper", chunks)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-result
		t.Fatal("Capture waited on a running helper after an invalid header")
	}
	cancel()
}

func TestListKillsHelperBeforeWaitingOnOversizeOutput(t *testing.T) {
	provider := &windowsProvider{helper: os.Args[0]}
	if !provider.available() {
		t.Skip("requires Windows 11")
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := provider.List(ctx)
		result <- err
	}()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("List accepted oversized helper output")
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-result
		t.Fatal("List waited on a running helper after oversized output")
	}
	cancel()
}
