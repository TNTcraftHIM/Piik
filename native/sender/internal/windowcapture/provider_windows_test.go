//go:build windows

package windowcapture

import (
	"context"
	"encoding/binary"
	"io"
	"os"
	"reflect"
	"testing"
	"time"
)

const testCreationTime = uint64(123456)
const testWindowHandle = uint64(987654)

func TestMain(main *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--list":
			_, _ = os.Stdout.Write(make([]byte, maxListBytes+1))
			select {}
		case "--capture-audio":
			if !reflect.DeepEqual(os.Args[2:], []string{"1", "123456"}) {
				os.Exit(3)
			}
			writeTestEnvelope(helperKindPCM, 0, 1, 200_000, make([]byte, 4))
			_, _ = os.Stdout.Write(make([]byte, helperHeaderSize))
			select {}
		case "--capture-window":
			expected := []string{
				"1", "123456", "987654", "--adapter-index", "2",
				"--mft-index", "3", "--protocol-v1",
			}
			if !reflect.DeepEqual(os.Args[2:], expected) {
				os.Exit(4)
			}
			status := []byte(`{"state":"starting","hardwareOnly":true,"adapterIndex":2,"adapterName":"GPU","adapterLuid":"0:1","mftIndex":3,"mftName":"MFT","mftClsid":"clsid"}`)
			writeTestEnvelope(helperKindStatus, 0, 0, 0, status)
			writeTestEnvelope(helperKindH264, 1, 100, 333_330, []byte{0, 0, 0, 1, 0x65})
			request := make([]byte, 1)
			if _, err := io.ReadFull(os.Stdin, request); err != nil || request[0] != 'K' {
				os.Exit(5)
			}
			_, _ = os.Stdout.Write(make([]byte, helperHeaderSize))
			select {}
		}
	}
	os.Exit(main.Run())
}

func writeTestEnvelope(kind, flags byte, timestamp, duration uint64, payload []byte) {
	header := make([]byte, helperHeaderSize)
	copy(header, helperProtocolMagic)
	header[4] = 1
	header[5] = kind
	header[6] = flags
	binary.BigEndian.PutUint64(header[8:16], timestamp)
	binary.BigEndian.PutUint64(header[16:24], duration)
	binary.BigEndian.PutUint32(header[24:28], uint32(len(payload)))
	_, _ = os.Stdout.Write(header)
	_, _ = os.Stdout.Write(payload)
}

func TestCaptureAudioPassesIdentityAndKillsHelperBeforeWaitOnInvalidHeader(t *testing.T) {
	provider := &windowsProvider{helper: os.Args[0]}
	if !provider.available() {
		t.Skip("requires Windows 11")
	}

	result := make(chan error, 1)
	chunks := 0
	go func() {
		result <- provider.CaptureAudio(context.Background(), Target{
			WindowHandle: testWindowHandle, PID: 1, CreationTime: testCreationTime,
		}, func(PCMChunk) error {
			chunks++
			return nil
		})
	}()

	select {
	case err := <-result:
		if err == nil || chunks != 1 {
			t.Fatalf("CaptureAudio error = %v, chunks = %d", err, chunks)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("CaptureAudio waited on a running helper after an invalid header")
	}
}

func TestCaptureWindowPassesBoundIdentityAndForwardsKeyFrameRequest(t *testing.T) {
	provider := &windowsProvider{helper: os.Args[0], adapterIndex: 2, mftIndex: 3}
	if !provider.available() {
		t.Skip("requires Windows 11")
	}

	keyFrames := make(chan struct{}, 1)
	result := make(chan error, 1)
	statuses, accessUnits := 0, 0
	go func() {
		result <- provider.CaptureWindow(context.Background(), Target{
			WindowHandle: testWindowHandle, PID: 1, CreationTime: testCreationTime,
		}, keyFrames, func(PCMChunk) error {
			return nil
		}, func(unit H264AccessUnit) error {
			accessUnits++
			if !unit.KeyFrame {
				t.Error("first access unit was not a key frame")
			}
			keyFrames <- struct{}{}
			return nil
		}, func(Status) error {
			statuses++
			return nil
		})
	}()

	select {
	case err := <-result:
		if err == nil || statuses != 1 || accessUnits != 1 {
			t.Fatalf("CaptureWindow error = %v, statuses = %d, access units = %d", err, statuses, accessUnits)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("CaptureWindow did not forward the key-frame request or kill the invalid helper")
	}
}

func TestListKillsHelperBeforeWaitingOnOversizeOutput(t *testing.T) {
	provider := &windowsProvider{helper: os.Args[0]}
	if !provider.available() {
		t.Skip("requires Windows 11")
	}

	result := make(chan error, 1)
	go func() {
		_, err := provider.List(context.Background())
		result <- err
	}()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("List accepted oversized helper output")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("List waited on a running helper after oversized output")
	}
}
