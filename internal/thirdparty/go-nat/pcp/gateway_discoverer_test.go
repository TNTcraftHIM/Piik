package pcp

import (
	"context"
	"errors"
	"net"
	"runtime"
	"testing"

	"github.com/google/gopacket/routing"
)

type fakeRouter struct {
	iface   *net.Interface
	gateway net.IP
	src     net.IP
	err     error
	gotDst  net.IP
}

func (f *fakeRouter) Route(dst net.IP) (*net.Interface, net.IP, net.IP, error) {
	f.gotDst = dst
	return f.iface, f.gateway, f.src, f.err
}

func (f *fakeRouter) RouteWithSrc(_ net.HardwareAddr, _, dst net.IP) (*net.Interface, net.IP, net.IP, error) {
	return f.Route(dst)
}

func stubRouter(t *testing.T, r routing.Router, err error) {
	t.Helper()
	orig := newRouter
	newRouter = func() (routing.Router, error) { return r, err }
	t.Cleanup(func() { newRouter = orig })
}

func TestDiscover(t *testing.T) {
	gw := net.ParseIP("192.168.1.1")
	local := net.ParseIP("192.168.1.100")

	tests := []struct {
		name    string
		router  *fakeRouter
		newErr  error
		wantErr error // nil means success; errors.New sentinels checked by identity
		anyErr  bool  // just expect some error
	}{
		{name: "netroute init error", newErr: errors.New("no netlink"), anyErr: true},
		{name: "route error", router: &fakeRouter{err: errors.New("no route")}, anyErr: true},
		{name: "nil gateway", router: &fakeRouter{src: local}, wantErr: ErrNoNATFound},
		{name: "nil local IP", router: &fakeRouter{gateway: gw}, wantErr: ErrNoInternalAddress},
		{name: "success", router: &fakeRouter{gateway: gw, src: local}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stubRouter(t, tt.router, tt.newErr)

			gateway, localIP, err := (&defaultGatewayDiscoverer{}).Discover(context.Background())

			if tt.anyErr || tt.wantErr != nil {
				if err == nil {
					t.Fatal("Discover() error = nil, want error")
				}
				if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
					t.Fatalf("Discover() error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Discover() error = %v", err)
			}
			if !gateway.Equal(gw) || !localIP.Equal(local) {
				t.Fatalf("Discover() = (%v, %v), want (%v, %v)", gateway, localIP, gw, local)
			}
		})
	}
}

// go-netroute's netlink lookup rejects an unspecified destination before it
// reaches the kernel, so Discover must not pass 0.0.0.0 or :: on Linux and
// Android. See defaultRouteProbe4.
func TestDiscoverLinuxDst(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-specific destination workaround")
	}

	r := &fakeRouter{gateway: net.ParseIP("192.168.1.1"), src: net.ParseIP("192.168.1.100")}
	stubRouter(t, r, nil)
	if _, _, err := (&defaultGatewayDiscoverer{}).Discover(context.Background()); err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if r.gotDst.IsUnspecified() {
		t.Fatalf("Discover() passed unspecified dst %v to Route on linux", r.gotDst)
	}

	r6 := &fakeRouter{gateway: net.ParseIP("2001:db8::1"), src: net.ParseIP("2001:db8::100")}
	stubRouter(t, r6, nil)
	if _, _, _, err := (&defaultGatewayDiscoverer{}).DiscoverV6(context.Background()); err != nil {
		t.Fatalf("DiscoverV6() error = %v", err)
	}
	if r6.gotDst.IsUnspecified() {
		t.Fatalf("DiscoverV6() passed unspecified dst %v to Route on linux", r6.gotDst)
	}
}

func TestDiscoverV6(t *testing.T) {
	local := net.ParseIP("2001:db8::100")
	eth0 := &net.Interface{Index: 1, Name: "eth0"}

	tests := []struct {
		name     string
		router   *fakeRouter
		newErr   error
		wantErr  error // nil means success; errors.New sentinels checked by identity
		anyErr   bool  // just expect some error
		wantZone string
	}{
		{name: "netroute init error", newErr: errors.New("no netlink"), anyErr: true},
		{name: "route error", router: &fakeRouter{err: errors.New("no route")}, anyErr: true},
		{name: "nil gateway", router: &fakeRouter{src: local}, wantErr: ErrNoNATFound},
		{name: "nil local IP", router: &fakeRouter{gateway: net.ParseIP("fe80::1")}, wantErr: ErrNoInternalAddress},
		{name: "global gateway has no zone", router: &fakeRouter{gateway: net.ParseIP("2001:db8::1"), src: local, iface: eth0}},
		{name: "link-local gateway gets iface zone", router: &fakeRouter{gateway: net.ParseIP("fe80::1"), src: local, iface: eth0}, wantZone: "eth0"},
		{name: "link-local gateway with nil iface", router: &fakeRouter{gateway: net.ParseIP("fe80::1"), src: local}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stubRouter(t, tt.router, tt.newErr)

			gateway, localIP, zone, err := (&defaultGatewayDiscoverer{}).DiscoverV6(context.Background())

			if tt.anyErr || tt.wantErr != nil {
				if err == nil {
					t.Fatal("DiscoverV6() error = nil, want error")
				}
				if tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
					t.Fatalf("DiscoverV6() error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("DiscoverV6() error = %v", err)
			}
			if !gateway.Equal(tt.router.gateway) || !localIP.Equal(local) {
				t.Fatalf("DiscoverV6() = (%v, %v), want (%v, %v)", gateway, localIP, tt.router.gateway, local)
			}
			if zone != tt.wantZone {
				t.Fatalf("DiscoverV6() zone = %q, want %q", zone, tt.wantZone)
			}
		})
	}
}
