package nat

import (
	"net"
	"runtime"

	"github.com/libp2p/go-netroute"
)

func getDefaultGateway() (net.IP, error) {
	router, err := netroute.New()
	if err != nil {
		return nil, err
	}

	dst := defaultRouteProbe4()

	_, ip, _, err := router.Route(dst)
	if err != nil {
		return nil, err
	}
	if ip == nil {
		return nil, ErrNoNATFound
	}
	return ip, nil
}

// defaultRouteProbe4 returns the destination to look up when asking for the
// default IPv4 route.
//
// On Linux and Android it is a concrete address rather than 0.0.0.0, because
// go-netroute's netlink implementation rejects an unspecified destination
// before it reaches the kernel. That implementation is newer than the version
// this module requires, so the two must both work: 0.0.0.0/8 is reserved and
// carries no route of its own, so 0.0.0.1 resolves to the default route on the
// older table-parsing implementation as well.
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
