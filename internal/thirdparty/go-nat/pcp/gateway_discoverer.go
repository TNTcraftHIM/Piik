package pcp

import (
	"context"
	"net"
	"runtime"

	"github.com/libp2p/go-netroute"
)

type gatewayDiscoverer interface {
	Discover(ctx context.Context) (gateway net.IP, localIP net.IP, err error)
	DiscoverV6(ctx context.Context) (gateway net.IP, localIP net.IP, zone string, err error)
}

type defaultGatewayDiscoverer struct{}

var _ gatewayDiscoverer = (*defaultGatewayDiscoverer)(nil)

var newRouter = netroute.New

// Discover returns the default IPv4 gateway and local IP using the system routing table.
func (d *defaultGatewayDiscoverer) Discover(ctx context.Context) (gateway net.IP, localIP net.IP, err error) {
	// router.Route is a synchronous system call that cannot observe
	// cancellation, so this is the only point where ctx is honored.
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}

	router, err := newRouter()
	if err != nil {
		return nil, nil, err
	}

	_, gateway, localIP, err = router.Route(defaultRouteProbe4())
	if err != nil {
		return nil, nil, err
	}

	if gateway == nil {
		return nil, nil, ErrNoNATFound
	}
	if localIP == nil {
		return nil, nil, ErrNoInternalAddress
	}

	return gateway, localIP, nil
}

// DiscoverV6 returns the default IPv6 gateway, local IP, and scope zone.
func (d *defaultGatewayDiscoverer) DiscoverV6(ctx context.Context) (gateway net.IP, localIP net.IP, zone string, err error) {
	// router.Route is a synchronous system call that cannot observe
	// cancellation, so this is the only point where ctx is honored.
	if err := ctx.Err(); err != nil {
		return nil, nil, "", err
	}

	router, err := newRouter()
	if err != nil {
		return nil, nil, "", err
	}

	iface, gateway, localIP, err := router.Route(defaultRouteProbe6())
	if err != nil {
		return nil, nil, "", err
	}

	if gateway == nil {
		return nil, nil, "", ErrNoNATFound
	}
	if localIP == nil {
		return nil, nil, "", ErrNoInternalAddress
	}
	if gateway.IsLinkLocalUnicast() && iface != nil {
		zone = iface.Name
	}

	return gateway, localIP, zone, nil
}

// defaultRouteProbe4 returns the destination to look up when asking for the
// default IPv4 route.
//
// On Linux and Android it is a concrete address rather than 0.0.0.0, because
// go-netroute's netlink implementation rejects an unspecified destination
// before it reaches the kernel. That implementation is newer than the version
// this module requires, so both must work: 0.0.0.0/8 is reserved and carries no
// route of its own, so 0.0.0.1 resolves to the default route on the older
// table-parsing implementation as well.
//
// TODO: on Android and iOS, use the platform APIs
// (ConnectivityManager.getLinkProperties / NWPathMonitor) when a netlink-based
// lookup is restricted or unavailable.
func defaultRouteProbe4() net.IP {
	if runtime.GOOS == "linux" || runtime.GOOS == "android" {
		return net.IPv4(0, 0, 0, 1)
	}
	return net.IPv4zero
}

// defaultRouteProbe6 is the IPv6 counterpart of defaultRouteProbe4. ::2 sits in
// the reserved range around the unspecified address and carries no route of its
// own, so it resolves to the default route.
func defaultRouteProbe6() net.IP {
	if runtime.GOOS == "linux" || runtime.GOOS == "android" {
		return net.IP{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2}
	}
	return net.IPv6zero
}
