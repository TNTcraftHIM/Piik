package app

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/P4-aaaul/Silip/internal/server/room"
)

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
	h := &harness{Server: server, t: t, baseURL: baseURL(port), client: testClient(t)}
	response := make(chan reply, 1)
	go func() { response <- h.createRoom(roomRequest{codeEntryPolicy: "open"}) }()
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
	result := <-response
	if !returned {
		closeErr = <-closed
	}
	if returned {
		t.Error("shutdown closed room storage while an admitted mutation still owned it")
	}
	if !errors.Is(closeErr, context.Canceled) {
		t.Fatalf("shutdown error = %v, want the HTTP drain cancellation", closeErr)
	}
	result.expectStatus(http.StatusCreated)

	restored, err := database.Initialize()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if len(restored) != 1 || restored[0].RoomID != result.room().RoomID {
		t.Fatalf("the accepted write was not restored: got %d rooms", len(restored))
	}
}
