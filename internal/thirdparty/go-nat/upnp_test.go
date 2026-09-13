package nat

import (
	"context"
	"errors"
	"maps"
	"net/netip"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/huin/goupnp"
)

// testRootDevice is a device description with a reachable base URL, which
// AddPortMapping needs to resolve the local address.
func testRootDevice(t *testing.T) *goupnp.RootDevice {
	t.Helper()
	base, err := url.Parse("http://127.0.0.1:5000/")
	if err != nil {
		t.Fatal(err)
	}
	return &goupnp.RootDevice{URLBase: *base}
}

func TestLocationHasAddr(t *testing.T) {
	gateway := netip.MustParseAddr("192.168.1.1")

	tests := []struct {
		name     string
		location string
		want     bool
	}{
		{
			name:     "the gateway itself",
			location: "http://192.168.1.1:5000/rootDesc.xml",
			want:     true,
		},
		{
			name:     "the gateway without a port",
			location: "http://192.168.1.1/rootDesc.xml",
			want:     true,
		},
		{
			name: "another host on the link answered",
			// A rogue responder steering discovery at a device it controls.
			location: "http://192.168.1.99:5000/rootDesc.xml",
		},
		{
			name:     "an off-link address",
			location: "http://203.0.113.7/rootDesc.xml",
		},
		{
			name: "a host name cannot be checked without resolving it",
			// A responder free to choose the name is also choosing what the
			// resolver returns, so the name proves nothing.
			location: "http://gateway.local:5000/rootDesc.xml",
		},
		{
			name:     "unparseable",
			location: "://nonsense",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := locationHasAddr(tt.location, gateway); got != tt.want {
				t.Fatalf("locationHasAddr(%q) = %v, want %v", tt.location, got, tt.want)
			}
		})
	}
}

func TestLocationHasAddrMatchesMappedGateway(t *testing.T) {
	// A gateway parsed from a net.IP may arrive as a v4-mapped v6 address.
	mapped := netip.MustParseAddr("::ffff:192.168.1.1")
	if !locationHasAddr("http://192.168.1.1:5000/rootDesc.xml", mapped) {
		t.Fatal("a v4-mapped gateway did not match its own address")
	}
}

func TestDeviceHostPort(t *testing.T) {
	tests := []struct {
		name    string
		urlBase string
		want    string
		wantErr error
	}{
		{
			name:    "explicit port",
			urlBase: "http://192.168.1.1:5000/",
			want:    "192.168.1.1:5000",
		},
		{
			name: "no port defaults to HTTP",
			// The UPnP Device Architecture lets a device URL omit the port.
			urlBase: "http://192.168.1.1/",
			want:    "192.168.1.1:80",
		},
		{
			name:    "IPv6 literal keeps its brackets",
			urlBase: "http://[fe80::1]:5000/",
			want:    "[fe80::1]:5000",
		},
		{
			name:    "IPv6 literal without a port",
			urlBase: "http://[fe80::1]/",
			want:    "[fe80::1]:80",
		},
		{
			name:    "hostname",
			urlBase: "http://gateway.local:49152/",
			want:    "gateway.local:49152",
		},
		{
			name:    "no base URL at all",
			urlBase: "",
			wantErr: errNoDeviceHost,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base, err := url.Parse(tt.urlBase)
			if err != nil {
				t.Fatal(err)
			}

			got, err := deviceHostPort(&goupnp.RootDevice{URLBase: *base})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("deviceHostPort() error = %v, want %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("deviceHostPort() = %q, want %q", got, tt.want)
			}
		})
	}
}

// fakeUPNPClient records the mappings a device holds.
type fakeUPNPClient struct {
	mu       sync.Mutex
	mappings map[string]uint16 // protocol -> external port
	addErr   error
	delErr   error
	adds     int
	deletes  int
}

func newFakeUPNPClient() *fakeUPNPClient {
	return &fakeUPNPClient{mappings: make(map[string]uint16)}
}

func (c *fakeUPNPClient) GetExternalIPAddressCtx(context.Context) (string, error) {
	return "203.0.113.1", nil
}

func (c *fakeUPNPClient) GetNATRSIPStatusCtx(context.Context) (bool, bool, error) {
	return false, true, nil
}

func (c *fakeUPNPClient) AddPortMappingCtx(_ context.Context, _ string, extPort uint16, protocol string, _ uint16, _ string, _ bool, _ string, _ uint32) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.adds++
	if c.addErr != nil {
		return c.addErr
	}
	c.mappings[protocol] = extPort
	return nil
}

func (c *fakeUPNPClient) DeletePortMappingCtx(_ context.Context, _ string, _ uint16, protocol string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.deletes++
	if c.delErr != nil {
		return c.delErr
	}
	delete(c.mappings, protocol)
	return nil
}

func (c *fakeUPNPClient) held() map[string]uint16 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.mappings)
}

func TestUPNPKeepsTCPAndUDPMappingsApart(t *testing.T) {
	client := newFakeUPNPClient()
	u := newUPNPNAT(client, "test", testRootDevice(t))

	ctx := context.Background()
	if _, err := u.AddPortMapping(ctx, "udp", 51820, "wg", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := u.AddPortMapping(ctx, "tcp", 51820, "wg", time.Hour); err != nil {
		t.Fatal(err)
	}
	if got := len(client.held()); got != 2 {
		t.Fatalf("device holds %d mappings, want 2 (TCP and UDP are independent)", got)
	}

	// Deleting one protocol must not make the other undeletable: keyed by port
	// alone, the shared cache entry is gone and the second delete is skipped.
	if err := u.DeletePortMapping(ctx, "udp", 51820); err != nil {
		t.Fatal(err)
	}
	if err := u.DeletePortMapping(ctx, "tcp", 51820); err != nil {
		t.Fatal(err)
	}

	if held := client.held(); len(held) != 0 {
		t.Fatalf("device still holds %v, want both mappings removed", held)
	}
}

func TestUPNPKeepsMappingAddressableAfterFailedDelete(t *testing.T) {
	client := newFakeUPNPClient()
	u := newUPNPNAT(client, "test", testRootDevice(t))
	ctx := context.Background()

	if _, err := u.AddPortMapping(ctx, "udp", 51820, "wg", time.Hour); err != nil {
		t.Fatal(err)
	}

	client.delErr = errors.New("device busy")
	if err := u.DeletePortMapping(ctx, "udp", 51820); err == nil {
		t.Fatal("DeletePortMapping() error = nil, want the device failure")
	}

	// The mapping is still on the device, so a retry must still address it.
	client.delErr = nil
	if err := u.DeletePortMapping(ctx, "udp", 51820); err != nil {
		t.Fatal(err)
	}
	if held := client.held(); len(held) != 0 {
		t.Fatalf("device still holds %v after retry", held)
	}
}
