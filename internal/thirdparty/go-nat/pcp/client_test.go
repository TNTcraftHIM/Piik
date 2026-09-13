package pcp

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"
)

// fakePCPServer is a minimal RFC 6887 server. It enforces the MAP nonce rules
// (§11.3, §15.1): a MAP request for an existing mapping whose nonce differs is
// answered with NOT_AUTHORIZED and the mapping is left untouched.
type fakePCPServer struct {
	conn *net.UDPConn

	mu       sync.Mutex
	mappings map[mappingKey][12]byte
	// corruptNext truncates the next MAP response: the server creates the
	// mapping but the client cannot parse the reply.
	corruptNext bool
	// refuseDeletes answers every zero-lifetime MAP with NO_RESOURCES and
	// keeps the mapping, standing in for a server that will not release one.
	refuseDeletes bool
	// silent drops every request, standing in for a gateway that advertised
	// PCP and then stopped answering.
	silent bool
	// gate, when non-nil, holds every request until a value is received, so a
	// test can keep one exchange in flight while it observes the client.
	gate chan struct{}
	// arrivals reports each request as it reaches the server.
	arrivals chan struct{}
}

// newFakePCPServer binds a fake server on addr, which must use the well-known
// PCP port: Client always sends there, and the discovery tests build their
// clients inside the package, so the port cannot be overridden per test. These
// tests therefore need port 5351 free on the host running them, which rules out
// a machine already running a PCP or NAT-PMP responder.
func newFakePCPServer(t *testing.T, network, addr string) *fakePCPServer {
	t.Helper()
	udpAddr, err := net.ResolveUDPAddr(network, addr)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.ListenUDP(network, udpAddr)
	if err != nil {
		t.Fatalf("bind fake PCP server on %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	server := &fakePCPServer{conn: conn, mappings: make(map[mappingKey][12]byte)}
	go server.serve()
	return server
}

func (s *fakePCPServer) serve() {
	buf := make([]byte, 128)
	for {
		n, from, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		// Each request is handled on its own goroutine so that gating one does
		// not also stall the requests a test is watching for.
		req := append([]byte(nil), buf[:n]...)
		go func() {
			if resp := s.handle(req); resp != nil {
				_, _ = s.conn.WriteToUDP(resp, from)
			}
		}()
	}
}

func (s *fakePCPServer) handle(req []byte) []byte {
	if len(req) < headerSize || req[0] != Version {
		return nil
	}

	s.mu.Lock()
	silent, gate, arrivals := s.silent, s.gate, s.arrivals
	s.mu.Unlock()
	if arrivals != nil {
		arrivals <- struct{}{}
	}
	if gate != nil {
		<-gate
	}
	if silent {
		return nil
	}

	const epoch = 1000
	switch req[1] {
	case OpAnnounce:
		resp := make([]byte, headerSize)
		resp[0] = Version
		resp[1] = OpAnnounce | OpReply
		binary.BigEndian.PutUint32(resp[8:12], epoch)
		return resp
	case OpMap:
		if len(req) < mapRequestSize {
			return nil
		}
		lifetime := binary.BigEndian.Uint32(req[4:8])
		var nonce [12]byte
		copy(nonce[:], req[24:36])
		key := mappingKey{proto: req[36], port: binary.BigEndian.Uint16(req[40:42])}

		resp := make([]byte, mapRequestSize)
		resp[0] = Version
		resp[1] = OpMap | OpReply
		binary.BigEndian.PutUint32(resp[4:8], lifetime)
		binary.BigEndian.PutUint32(resp[8:12], epoch)
		copy(resp[24:36], nonce[:])
		resp[36] = key.proto
		binary.BigEndian.PutUint16(resp[40:42], key.port)
		binary.BigEndian.PutUint16(resp[42:44], key.port)
		extIP := addrTo16(netip.MustParseAddr("192.0.2.1"))
		copy(resp[44:60], extIP[:])

		s.mu.Lock()
		defer s.mu.Unlock()
		if stored, ok := s.mappings[key]; ok && stored != nonce {
			resp[3] = ResultNotAuthorized
			binary.BigEndian.PutUint32(resp[4:8], 0)
			return resp
		}
		if lifetime == 0 {
			if s.refuseDeletes {
				resp[3] = ResultNoResources
				return resp
			}
			delete(s.mappings, key)
		} else {
			s.mappings[key] = nonce
		}
		if s.corruptNext {
			s.corruptNext = false
			return resp[:headerSize]
		}
		return resp
	}
	return nil
}

func (s *fakePCPServer) hasMapping(proto uint8, port uint16) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.mappings[mappingKey{proto: proto, port: port}]
	return ok
}

// RFC 6887 requires renewals and deletes to carry the nonce the mapping was
// created with; a server answers a different nonce with NOT_AUTHORIZED.
func TestPortMappingNonceReuse(t *testing.T) {
	server := newFakePCPServer(t, "udp4", "127.0.0.1:5351")

	newTestClient := func() *Client {
		client := NewClientWithTimeout(net.IPv4(127, 0, 0, 1), time.Second)
		client.SetLocalIP(net.IPv4(127, 0, 0, 1))
		return client
	}

	t.Run("renew reuses create nonce", func(t *testing.T) {
		client := newTestClient()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if _, err := client.AddPortMapping(ctx, "udp", 4444, time.Hour); err != nil {
			t.Fatalf("create mapping: %v", err)
		}
		if _, err := client.AddPortMapping(ctx, "udp", 4444, time.Hour); err != nil {
			t.Fatalf("renew mapping: %v (renew must reuse the create nonce)", err)
		}
	})

	t.Run("delete reuses nonce of create whose response was lost", func(t *testing.T) {
		client := newTestClient()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		server.mu.Lock()
		server.corruptNext = true
		server.mu.Unlock()

		if _, err := client.AddPortMapping(ctx, "udp", 4446, time.Hour); err == nil {
			t.Fatal("create with corrupted response: error = nil, want parse failure")
		}
		if !server.hasMapping(ProtoUDP, 4446) {
			t.Fatal("server did not create the mapping")
		}
		if err := client.DeletePortMapping(ctx, "udp", 4446); err != nil {
			t.Fatalf("delete mapping: %v (must reuse the nonce sent with the failed create)", err)
		}
		if server.hasMapping(ProtoUDP, 4446) {
			t.Fatal("mapping still present on server: pinhole leaks after a lost create response")
		}
	})

	t.Run("delete reuses create nonce and removes mapping", func(t *testing.T) {
		client := newTestClient()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if _, err := client.AddPortMapping(ctx, "udp", 4445, time.Hour); err != nil {
			t.Fatalf("create mapping: %v", err)
		}
		err := client.DeletePortMapping(ctx, "udp", 4445)
		if server.hasMapping(ProtoUDP, 4445) {
			if err == nil {
				t.Fatal("mapping still present on server and DeletePortMapping returned nil: NOT_AUTHORIZED was silently swallowed")
			}
			t.Fatalf("mapping still present on server: %v", err)
		}
		if err != nil {
			t.Fatalf("delete mapping: %v", err)
		}
	})
}

func TestSendOnceStopsOnCancel(t *testing.T) {
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close() }()

	received := make(chan error, 1)
	go func() {
		buffer := make([]byte, 1)
		_, _, err := server.ReadFromUDP(buffer)
		received <- err
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := (&Client{timeout: 10 * time.Second}).sendOnce(ctx, server.LocalAddr().(*net.UDPAddr), []byte{0})
		done <- err
	}()

	select {
	case err := <-received:
		if err != nil {
			t.Fatal(err)
		}
	case err := <-done:
		t.Fatalf("send stopped before cancellation: %v", err)
	case <-time.After(time.Second):
		t.Fatal("server did not receive PCP packet")
	}

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("send error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(time.Second):
		t.Fatal("send did not stop after cancellation")
	}
}

// A delete must not overtake a create for the same mapping. The nonce is the
// server's identity for a mapping, so a delete completing first drops the nonce
// the created mapping needs, stranding one no later delete can remove.
func TestPortMappingRequestsAreSerializedPerMapping(t *testing.T) {
	server := newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	gate := make(chan struct{})
	arrivals := make(chan struct{}, 8)
	server.mu.Lock()
	server.gate, server.arrivals = gate, arrivals
	server.mu.Unlock()

	client := NewClientWithTimeout(net.IPv4(127, 0, 0, 1), 5*time.Second)
	client.SetLocalIP(net.IPv4(127, 0, 0, 1))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	createDone := make(chan error, 1)
	go func() {
		_, err := client.AddPortMapping(ctx, "udp", 4447, time.Hour)
		createDone <- err
	}()

	// Hold the create at the server.
	select {
	case <-arrivals:
	case <-time.After(5 * time.Second):
		t.Fatal("create never reached the server")
	}

	deleteDone := make(chan error, 1)
	go func() { deleteDone <- client.DeletePortMapping(ctx, "udp", 4447) }()

	// The delete must not reach the server while the create is in flight.
	select {
	case <-arrivals:
		t.Fatal("delete reached the server while the create was still in flight")
	case err := <-deleteDone:
		t.Fatalf("delete completed before the create: %v", err)
	case <-time.After(300 * time.Millisecond):
	}

	close(gate)
	if err := <-createDone; err != nil {
		t.Fatalf("create mapping: %v", err)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("delete mapping: %v (the create's nonce must still be held)", err)
	}
	if server.hasMapping(ProtoUDP, 4447) {
		t.Fatal("mapping still present on server")
	}
}
