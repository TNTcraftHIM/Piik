// Copyright 2026 Piik contributors. Licensed under Apache-2.0.
package nat

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"

	natpmp "github.com/jackpal/go-nat-pmp"
)

// Use the protocol's real UDP endpoint so the adapter and its client are tested
// together. The check runner serializes gateway fixture packages on port 5351.
func natpmpServer(t *testing.T, reply func([]byte) []byte) (net.IP, <-chan []byte) {
	t.Helper()
	ip := net.IPv4(127, 0, 0, 1)
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: 5351})
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan []byte, 32)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(requests)
		for {
			buffer := make([]byte, 64)
			n, addr, err := server.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			request := buffer[:n]
			requests <- request
			if response := reply(request); response != nil {
				_, _ = server.WriteToUDP(response, addr)
			}
		}
	}()
	t.Cleanup(func() {
		_ = server.Close()
		<-done
	})
	return ip, requests
}

func mappingResponse(request []byte, external uint16) []byte {
	response := make([]byte, 16)
	response[1] = request[1] | 0x80
	copy(response[8:10], request[4:6])
	binary.BigEndian.PutUint16(response[10:12], external)
	copy(response[12:16], request[8:12])
	return response
}

func TestNATPMPUsesAssignedPortsAndDeletesWithPCPv6(t *testing.T) {
	assigned := uint16(45000)
	ip, requests := natpmpServer(t, func(request []byte) []byte {
		assigned++
		return mappingResponse(request, assigned)
	})
	ipv4 := &natpmpNAT{natpmp.NewClientWithTimeout(ip, time.Second), ip, make(map[int]int)}
	ipv6 := &fakePCPMapper{}
	gateway := newNATWithPCPIPv6(ipv4, ipv6)
	for _, expected := range []int{45001, 45002} {
		port, err := gateway.AddPortMapping(context.Background(), "udp", 43210, "test", time.Hour)
		if err != nil || port != expected {
			t.Fatalf("port = %d, err = %v, want %d", port, err, expected)
		}
		request := <-requests
		if expected == 45002 && binary.BigEndian.Uint16(request[6:8]) != 45001 {
			t.Fatalf("renewal did not request the assigned port: %v", request)
		}
	}
	if err := gateway.DeletePortMapping(context.Background(), "udp", 43210); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-requests:
		if request[1] != 1 || binary.BigEndian.Uint16(request[4:6]) != 43210 ||
			binary.BigEndian.Uint16(request[6:8]) != 0 || binary.BigEndian.Uint32(request[8:12]) != 0 {
			t.Fatalf("invalid deletion request: %v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("DeletePortMapping sent no deletion request")
	}
	if len(ipv4.ports) != 0 || ipv6.adds != 2 || ipv6.deletes != 1 {
		t.Fatalf("cleanup: ports=%v, IPv6 adds=%d deletes=%d", ipv4.ports, ipv6.adds, ipv6.deletes)
	}
}

func TestNATPMPFailedDeleteRetainsMapping(t *testing.T) {
	ip, requests := natpmpServer(t, func(request []byte) []byte {
		response := mappingResponse(request, 45001)
		if binary.BigEndian.Uint32(request[8:12]) == 0 {
			response[3] = 2 // Not authorized: do not forget the still-owned mapping.
		}
		return response
	})
	gateway := &natpmpNAT{natpmp.NewClientWithTimeout(ip, time.Second), ip, make(map[int]int)}
	if _, err := gateway.AddPortMapping(context.Background(), "udp", 43210, "test", time.Hour); err != nil {
		t.Fatal(err)
	}
	<-requests
	if err := gateway.DeletePortMapping(context.Background(), "udp", 43210); err == nil {
		t.Fatal("rejected deletion returned no error")
	}
	if gateway.ports[43210] != 45001 {
		t.Fatalf("failed deletion forgot mapping: %v", gateway.ports)
	}
}

func TestNATPMPMappingTimeoutStillAllowsDeletion(t *testing.T) {
	ip, requests := natpmpServer(t, func(request []byte) []byte {
		if binary.BigEndian.Uint32(request[8:12]) == 0 {
			return mappingResponse(request, 0)
		}
		return nil // The router created the mapping, but its response was lost.
	})
	gateway := &natpmpNAT{natpmp.NewClientWithTimeout(ip, 500*time.Millisecond), ip, make(map[int]int)}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := gateway.AddPortMapping(ctx, "udp", 43210, "test", time.Hour)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("mapping error = %v, want DeadlineExceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Fatalf("mapping continued after its deadline for %v", elapsed)
	}
	<-requests
	if err := gateway.DeletePortMapping(context.Background(), "udp", 43210); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-requests:
		if binary.BigEndian.Uint16(request[6:8]) != 0 || binary.BigEndian.Uint32(request[8:12]) != 0 {
			t.Fatalf("expected deletion after a lost mapping reply: %v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("a lost reply prevented cleanup")
	}
}

func TestNATPMPDiscoveryStopsOnCancel(t *testing.T) {
	ip, requests := natpmpServer(t, func([]byte) []byte { return nil })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := discoverNATPMPWithAddr(ctx, ip)
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("discovery did not start")
	}
	cancel()
	select {
	case gateway, ok := <-result:
		if ok || gateway != nil {
			t.Fatal("canceled discovery published a gateway")
		}
	case <-time.After(time.Second):
		t.Fatal("discovery did not stop")
	}
}
