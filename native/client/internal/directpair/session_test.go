package directpair

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const testInvitation = "http://192.168.1.2:8787/r/6020#v=AAAAAAAAAAAAAAAAAAAAAQ"

func TestPairingCodeRoundTripIsStrict(t *testing.T) {
	if _, _, err := invitationPath(testInvitation); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		"/r/6020#v=AAAAAAAAAAAAAAAAAAAAAQ",
		"http://example.test/r/6020",
		"http://example.test/r/6020#v=short",
		"http://example.test/r/6020?leak=yes#v=AAAAAAAAAAAAAAAAAAAAAQ",
	} {
		if _, _, err := invitationPath(invalid); err == nil {
			t.Fatalf("invalid invitation accepted: %s", invalid)
		}
	}
	if _, err := validateSTUNURLs([]string{"turn:turn.example:3478"}); err == nil {
		t.Fatal("TURN URL was accepted for direct pairing")
	}
	offer, err := encodeDescription("offer", testDescription(), []string{DefaultSTUNURL}, 8787)
	if err != nil {
		t.Fatal(err)
	}
	description, stunURLs, port, err := decodeDescription(offer, "offer")
	if err != nil || description.SDP != testDescription().SDP ||
		len(stunURLs) != 1 || stunURLs[0] != DefaultSTUNURL || port != 8787 {
		t.Fatalf("decoded offer = %+v, %v, %d, %v", description, stunURLs, port, err)
	}
	if _, _, _, err = decodeDescription(offer, "answer"); err == nil {
		t.Fatal("offer code was accepted as an answer")
	}
}

func TestDirectPairCarriesConcurrentTCPStreams(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	target := startEchoServer(t)
	_, targetPort, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatal(err)
	}
	host, offer, err := NewHost(ctx, HostOptions{
		Invitation:      "http://192.168.1.2:" + targetPort + "/r/6020#v=AAAAAAAAAAAAAAAAAAAAAQ",
		TargetAddress:   target,
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	viewer, answer, err := NewViewer(ctx, offer, ViewerOptions{
		ListenAddress:   "127.0.0.1:0",
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = viewer.Close() })
	if err = host.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	if err = host.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	invitation, err := viewer.WaitInvitation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(invitation, "/r/6020#v=AAAAAAAAAAAAAAAAAAAAAQ") {
		t.Fatalf("viewer invitation = %q", invitation)
	}

	var group sync.WaitGroup
	for index := range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			connection, dialErr := net.DialTimeout("tcp4", viewer.ListenAddress(), 3*time.Second)
			if dialErr != nil {
				t.Error(dialErr)
				return
			}
			defer connection.Close()
			message := fmt.Sprintf("stream-%d\n", index)
			if _, writeErr := io.WriteString(connection, message); writeErr != nil {
				t.Error(writeErr)
				return
			}
			_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
			actual, readErr := bufio.NewReader(connection).ReadString('\n')
			if readErr != nil || actual != message {
				t.Errorf("echo = %q, %v; want %q", actual, readErr, message)
			}
		}()
	}
	group.Wait()

	connection, err := net.DialTimeout("tcp4", viewer.ListenAddress(), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	payload := bytes.Repeat([]byte("0123456789abcdef"), 16*1024)
	written := make(chan error, 1)
	go func() {
		_, writeErr := connection.Write(payload)
		written <- writeErr
	}()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	echo := make([]byte, len(payload))
	if _, err = io.ReadFull(connection, echo); err != nil {
		t.Fatal(err)
	}
	if err = <-written; err != nil || !bytes.Equal(echo, payload) {
		t.Fatalf("large stream failed: %v", err)
	}
}

func testDescription() webrtc.SessionDescription {
	return webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n"}
}

func startEchoServer(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer connection.Close()
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()
	return listener.Addr().String()
}
