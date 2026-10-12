package mediaedge

import (
	"bytes"
	"github.com/pion/logging"
	"github.com/pion/stun/v4"
	"github.com/pion/transport/v5/vnet"
	"net"
	"testing"
)

// In-memory TEST-NET addresses only. No public host or OS socket is contacted.
const punchSTUNIP = "198.51.100.254"

type punchLab struct {
	wan     *vnet.Router
	nets    [2]*vnet.Net
	private [2]string
	public  [2]string
}

func newPunchLab(t *testing.T, left, right vnet.NATType) *punchLab {
	t.Helper()
	logger := logging.NewDefaultLoggerFactory()
	logger.DefaultLogLevel = logging.LogLevelError
	wan, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: "0.0.0.0/0", LoggerFactory: logger})
	if err != nil {
		t.Fatal(err)
	}
	network := &punchLab{wan: wan, private: [2]string{"10.11.0.2", "10.12.0.2"}, public: [2]string{"198.51.100.1", "198.51.100.2"}}
	for i, kind := range []vnet.NATType{left, right} {
		lan, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: network.private[i] + "/24", StaticIPs: []string{network.public[i]}, NATType: &kind, LoggerFactory: logger})
		if err != nil {
			t.Fatal(err)
		}
		endpoint, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{network.private[i]}})
		if err != nil {
			t.Fatal(err)
		}
		if err := lan.AddNet(endpoint); err != nil {
			t.Fatal(err)
		}
		if err := wan.AddRouter(lan); err != nil {
			t.Fatal(err)
		}
		network.nets[i] = endpoint
	}
	serverNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{punchSTUNIP}})
	if err != nil {
		t.Fatal(err)
	}
	if err := wan.AddNet(serverNet); err != nil {
		t.Fatal(err)
	}
	if err := wan.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wan.Stop() })
	for _, port := range []string{"3478", "3479", "3480"} {
		startPunchSTUN(t, serverNet, port)
	}
	return network
}

func startPunchSTUN(t *testing.T, serverNet *vnet.Net, port string) {
	t.Helper()
	server, err := serverNet.ListenPacket("udp4", punchSTUNIP+":"+port)
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	t.Cleanup(func() { _ = server.Close(); <-stopped })
	go func() {
		defer close(stopped)
		buffer := make([]byte, 2048)
		for {
			n, addr, err := server.ReadFrom(buffer)
			if err != nil {
				return
			}
			message := &stun.Message{Raw: bytes.Clone(buffer[:n])}
			if message.Decode() != nil || message.Type != stun.BindingRequest {
				continue
			}
			source := addr.(*net.UDPAddr)
			reply, err := stun.Build(stun.BindingSuccess, stun.NewTransactionIDSetter(message.TransactionID), &stun.XORMappedAddress{IP: source.IP, Port: source.Port})
			if err == nil {
				_, _ = server.WriteTo(reply.Raw, addr)
			}
		}
	}()
}
