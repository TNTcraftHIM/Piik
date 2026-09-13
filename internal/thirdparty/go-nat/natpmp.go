// Modified by Piik: honor request contexts, gateway-assigned ports and deletion.
package nat

import (
	"context"
	"net"
	"time"

	natpmp "github.com/jackpal/go-nat-pmp"
)

var (
	_ NAT = (*natpmpNAT)(nil)
)

func discoverNATPMP(ctx context.Context) <-chan NAT {
	ip, err := getDefaultGateway()
	if err != nil {
		return nil
	}
	return discoverNATPMPWithAddr(ctx, ip)
}

func discoverNATPMPWithAddr(ctx context.Context, ip net.IP) <-chan NAT {
	res := make(chan NAT, 1)
	go func() {
		defer close(res)
		client := natpmp.NewClient(ip)
		_, err := client.GetExternalAddressContext(ctx)
		if err != nil {
			return
		}
		res <- &natpmpNAT{client, ip, make(map[int]int)}
	}()
	return res
}

type natpmpNAT struct {
	c       *natpmp.Client
	gateway net.IP
	ports   map[int]int
}

func (n *natpmpNAT) GetDeviceAddress() (addr net.IP, err error) {
	return n.gateway, nil
}

func (n *natpmpNAT) GetInternalAddress() (addr net.IP, err error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			return nil, err
		}

		for _, addr := range addrs {
			switch x := addr.(type) {
			case *net.IPNet:
				if x.Contains(n.gateway) {
					return x.IP, nil
				}
			}
		}
	}

	return nil, ErrNoInternalAddress
}

func (n *natpmpNAT) GetExternalAddress() (addr net.IP, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), deviceTimeout)
	defer cancel()
	res, err := n.c.GetExternalAddressContext(ctx)
	if err != nil {
		return nil, err
	}

	d := res.ExternalIPAddress
	return net.IPv4(d[0], d[1], d[2], d[3]), nil
}

func (n *natpmpNAT) AddPortMapping(ctx context.Context, protocol string, internalPort int, _ string, timeout time.Duration) (int, error) {
	var (
		err    error
		result *natpmp.AddPortMappingResult
	)

	timeoutInSeconds := int(timeout / time.Second)

	if externalPort := n.ports[internalPort]; externalPort > 0 {
		result, err = n.c.AddPortMappingContext(ctx, protocol, internalPort, externalPort, timeoutInSeconds)
		if err == nil {
			externalPort = int(result.MappedExternalPort)
			n.ports[internalPort] = externalPort
			return externalPort, nil
		}
	}

	for i := 0; i < 3; i++ {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		externalPort := randomPort()
		result, err = n.c.AddPortMappingContext(ctx, protocol, internalPort, externalPort, timeoutInSeconds)
		if err == nil {
			externalPort = int(result.MappedExternalPort)
			n.ports[internalPort] = externalPort
			return externalPort, nil
		}
	}

	return 0, err
}

func (n *natpmpNAT) DeletePortMapping(ctx context.Context, protocol string, internalPort int) (err error) {
	// RFC 6886 section 3.4: lifetime and suggested external port are both zero.
	// Send even without a cached response: an earlier request may have succeeded
	// on the gateway while its reply was lost.
	if _, err := n.c.AddPortMappingContext(ctx, protocol, internalPort, 0, 0); err != nil {
		return err
	}
	delete(n.ports, internalPort)
	return nil
}

func (n *natpmpNAT) Type() string {
	return "NAT-PMP"
}
