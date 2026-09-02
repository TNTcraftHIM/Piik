package supervisor

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"testing"
)

func TestStartWaitsForReadinessAndClosesThroughStdin(t *testing.T) {
	port := freePort(t)
	process, err := Start(context.Background(), helperCommand(port, "serve"))
	if err != nil {
		t.Fatal(err)
	}
	if err = process.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.Done():
	default:
		t.Fatal("supervised process did not finish")
	}
}

func TestStartReportsAChildThatExitsBeforeReadiness(t *testing.T) {
	if _, err := Start(context.Background(), helperCommand(freePort(t), "exit")); err == nil {
		t.Fatal("early child exit was accepted")
	}
}

func TestSupervisorChild(t *testing.T) {
	if os.Getenv("SCREENER_SUPERVISOR_TEST_CHILD") != "true" {
		return
	}
	if os.Getenv("SCREENER_SUPERVISOR_TEST_MODE") == "exit" {
		os.Exit(3)
	}
	port, err := strconv.Atoi(os.Getenv("SCREENER_SUPERVISOR_TEST_PORT"))
	if err != nil {
		os.Exit(4)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/healthz" {
			http.NotFound(response, request)
			return
		}
		response.WriteHeader(http.StatusOK)
	})}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		os.Exit(5)
	}
	go func() { _ = server.Serve(listener) }()
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = server.Close()
	os.Exit(0)
}

func helperCommand(port int, mode string) Command {
	return Command{
		Path: os.Args[0],
		Args: []string{"-test.run=TestSupervisorChild"},
		Environment: append(os.Environ(),
			"SCREENER_SUPERVISOR_TEST_CHILD=true",
			"SCREENER_SUPERVISOR_TEST_MODE="+mode,
			fmt.Sprintf("SCREENER_SUPERVISOR_TEST_PORT=%d", port),
		),
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/healthz", port),
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
