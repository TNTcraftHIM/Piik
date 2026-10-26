package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestOwnedHTTPListenerFailureReachesOwner(t *testing.T) {
	listeners := make([]net.Listener, 2)
	for index := range listeners {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		listeners[index] = listener
		defer listener.Close()
	}
	server, err := New(Options{Config: testConfig(t), Listeners: listeners})
	if err != nil {
		t.Fatal(err)
	}
	defer server.End(context.Background())
	if _, err = server.Listen(t.Context()); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: time.Second}
	health := func(listener net.Listener) int {
		t.Helper()
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", listener.Addr().(*net.TCPAddr).Port))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}
	if health(listeners[0]) != http.StatusOK || health(listeners[1]) != http.StatusOK {
		t.Fatal("listeners did not become ready")
	}
	listeners[0].Close()
	select {
	case err = <-server.Done():
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("lost listener failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("dead HTTP listener was not reported to its owner")
	}
	if server.acceptingTraffic.Load() || health(listeners[1]) != http.StatusServiceUnavailable {
		t.Fatal("failed service remained ready on its surviving listener")
	}
	if err = server.reconcile(); err == nil || server.acceptingTraffic.Load() {
		t.Fatal("startup reconciliation revived a failed listener")
	}
	listeners[1].Close()
	if err = server.End(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-server.Done():
		t.Fatalf("reported another fatal event: %v", err)
	default:
	}
}

func TestOwnerShutdownDoesNotReportListenerFailure(t *testing.T) {
	for _, end := range []bool{false, true} {
		t.Run(fmt.Sprint("end=", end), func(t *testing.T) {
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			server, err := New(Options{Config: testConfig(t), Listeners: []net.Listener{listener}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = server.Listen(t.Context()); err != nil {
				t.Fatal(err)
			}
			if end {
				err = server.End(context.Background())
			} else {
				err = server.Close(context.Background())
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-server.Done():
				t.Fatalf("normal shutdown reported failure: %v", err)
			default:
			}
		})
	}
}
