package app

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/room"
)

func TestShutdownRetiresAcceptedHTTPConnectionsAfterDrainTimeout(t *testing.T) {
	for _, endRooms := range []bool{false, true} {
		t.Run(fmt.Sprintf("endRooms=%v", endRooms), func(t *testing.T) {
			server := newServer(t, Options{})
			port, err := server.Listen(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			address := fmt.Sprintf("127.0.0.1:%d", port)
			connections := make([]net.Conn, 0, 3)
			for _, header := range []string{
				"GET /healthz HTTP/1.1\r\nHost: " + address + "\r\n\r\n",
				"GET / HTTP/1.1\r\n",
				"GET /ws HTTP/1.1\r\nHost: " + address + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n",
			} {
				connection, err := net.Dial("tcp", address)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = connection.Close() })
				connections = append(connections, connection)
				if _, err := io.WriteString(connection, header); err != nil {
					t.Fatal(err)
				}
				if len(connections) == 1 {
					response, err := http.ReadResponse(bufio.NewReader(connection), nil)
					if err != nil {
						t.Fatal(err)
					}
					_, err = io.Copy(io.Discard, response.Body)
					response.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
			defer cancel()
			if endRooms {
				err = server.End(ctx)
			} else {
				err = server.Close(ctx)
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("shutdown lost drain timeout: %v", err)
			}
			for index, connection := range connections {
				if err := connection.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
					t.Fatal(err)
				}
				_, err := io.Copy(io.Discard, connection)
				var timeout net.Error
				if errors.As(err, &timeout) && timeout.Timeout() {
					t.Errorf("accepted connection[%d] remains open after shutdown", index)
				}
			}
		})
	}
}

type admittedBody struct {
	io.ReadCloser
	beforeRead func()
}

func (body *admittedBody) Read(p []byte) (int, error) {
	if before := body.beforeRead; before != nil {
		body.beforeRead = nil
		before()
	}
	return body.ReadCloser.Read(p)
}

func TestShutdownDoesNotCloseStorageDuringAnAdmittedRoomWrite(t *testing.T) {
	admitted, readBody := make(chan struct{}), make(chan struct{})
	mutating, finishMutation := make(chan struct{}), make(chan struct{})
	for _, gate := range []chan struct{}{readBody, finishMutation} {
		defer func() {
			select {
			case <-gate:
			default:
				close(gate)
			}
		}()
	}
	database, err := room.NewDatabase(filepath.Join(t.TempDir(), "rooms.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := room.New(room.Options{
		MaxRooms: room.Capacity, MaxViewersPerRoom: 20, Database: database,
		Random: func(size int) []byte {
			// Hold an actual creation inside the signaling-owned store mutation.
			if size == 32 {
				close(mutating)
				<-finishMutation
			}
			value := make([]byte, size)
			_, _ = rand.Read(value)
			return value
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	configuration := testConfig(t)
	configuration.SiteAccessPassword = ""
	server := newServer(t, Options{Config: configuration, RoomStore: store})
	server.httpServer.Handler = http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		request.Body = &admittedBody{ReadCloser: request.Body, beforeRead: func() {
			close(admitted)
			<-readBody
		}}
		server.ServeHTTP(writer, request)
	})
	port, err := server.Listen(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, baseURL(port)+"/api/rooms",
		strings.NewReader(`{"codeEntryPolicy":"open","preferredRoomId":"1234"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", allowedOrigin)
	request.Header.Set("Content-Type", "application/json")
	client := testClient(t)
	response := make(chan error, 1)
	go func() {
		reply, err := client.Do(request)
		if reply != nil {
			_, err = io.Copy(io.Discard, reply.Body)
			reply.Body.Close()
		}
		response <- err
	}()
	<-admitted

	// HTTP draining starts after signaling closes. An already admitted body
	// can still finish and enter a store mutation during that drain.
	draining := make(chan struct{})
	server.httpServer.RegisterOnShutdown(func() { close(draining) })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- server.Close(ctx) }()
	<-draining
	close(readBody)
	<-mutating
	cancel()
	var closeErr error
	returned := false
	select {
	case closeErr = <-closed:
		returned = true
	case <-time.After(100 * time.Millisecond):
	}
	close(finishMutation)
	responseErr := <-response
	if !returned {
		closeErr = <-closed
	}
	if returned {
		t.Error("shutdown closed room storage while an admitted mutation still owned it")
	}
	if !errors.Is(closeErr, context.Canceled) {
		t.Fatalf("shutdown error = %v, want the HTTP drain cancellation", closeErr)
	}
	if responseErr == nil {
		t.Error("HTTP response survived forced retirement after the drain deadline")
	}

	restored, err := database.Initialize()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if len(restored) != 1 || restored[0].RoomID != "1234" {
		t.Fatalf("the accepted write was not restored: got %d rooms", len(restored))
	}
}
