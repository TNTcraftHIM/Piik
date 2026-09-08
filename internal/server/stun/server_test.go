package stun

import (
	"bytes"
	"net"
	"testing"
	"time"

	"github.com/pion/stun/v3"
)

func TestThreeSTUNListenersWithoutRelayAndWithCompleteShutdown(t *testing.T) {
	server, err := Listen(t.Context(), []string{"127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	client, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, address := range server.Addresses {
		response := exchange(t, client, address, stun.BindingRequest)
		var mapped stun.XORMappedAddress
		if response.Type != stun.BindingSuccess || mapped.GetFrom(response) != nil {
			t.Fatal("STUN did not return a binding response")
		}
		local := client.LocalAddr().(*net.UDPAddr)
		if mapped.Port != local.Port || !mapped.IP.Equal(local.IP) {
			t.Fatal("STUN returned a different socket's address")
		}
		response = exchange(t, client, address, stun.NewType(stun.MethodAllocate, stun.ClassRequest))
		if response.Type.Class != stun.ClassErrorResponse || server.AllocationCount() != 0 {
			t.Fatal("STUN-only listener allowed TURN allocation")
		}
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	for _, address := range server.Addresses {
		reopened, err := net.ListenPacket("udp4", address.String())
		if err != nil {
			t.Fatal("STUN socket remained open after shutdown")
		}
		_ = reopened.Close()
	}
}

func TestOccupiedListenerRollsBackOnlyNewSockets(t *testing.T) {
	first, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	firstAddress := first.LocalAddr().String()
	_ = first.Close()
	occupied, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	server, err := Listen(t.Context(), []string{firstAddress, occupied.LocalAddr().String(), "127.0.0.1:0"})
	if err == nil || server != nil {
		if server != nil {
			_ = server.Close()
		}
		t.Fatal("occupied listener was accepted")
	}
	reopened, err := net.ListenPacket("udp4", firstAddress)
	if err != nil {
		t.Fatal("failed startup retained an earlier socket")
	}
	_ = reopened.Close()
	if err := occupied.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal("failed startup closed a foreign socket")
	}
}

func exchange(t *testing.T, client net.PacketConn, destination net.Addr, kind stun.MessageType) *stun.Message {
	t.Helper()
	request := stun.MustBuild(stun.TransactionID, kind)
	if err := client.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WriteTo(request.Raw, destination); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1500)
	count, source, err := client.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	response := &stun.Message{Raw: buffer[:count]}
	if response.Decode() != nil || source.String() != destination.String() ||
		!bytes.Equal(response.TransactionID[:], request.TransactionID[:]) {
		t.Fatal("STUN response identity did not match")
	}
	return response
}
