package nat

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/huin/goupnp"
	"github.com/huin/goupnp/dcps/internetgateway1"
	"github.com/huin/goupnp/dcps/internetgateway2"
	"github.com/huin/goupnp/httpu"
	"github.com/koron/go-ssdp"
)

const ssdpPort uint16 = 1900

const (
	searchRepeats = 3

	// defaultHTTPPort is what a UPnP device URL means when it omits the port.
	defaultHTTPPort = "80"
)

// deviceTimeout bounds a call to the gateway made by a NAT interface method
// that takes no context of its own.
const deviceTimeout = 10 * time.Second

// upnpDiscovery names how a UPnP device was found. It ends up in the NAT type,
// which is what callers log.
type upnpDiscovery string

const (
	upnpDiscoveryUnicast   upnpDiscovery = "unicast"
	upnpDiscoveryMulticast upnpDiscovery = "multicast"
)

// upnpSearchTarget is an SSDP ST header value.
type upnpSearchTarget string

const (
	searchTargetIGDv2 upnpSearchTarget = "urn:schemas-upnp-org:device:InternetGatewayDevice:2"
	searchTargetIGDv1 upnpSearchTarget = "urn:schemas-upnp-org:device:InternetGatewayDevice:1"
	searchTargetAll   upnpSearchTarget = "ssdp:all"
)

// errNoDeviceHost is returned when a UPnP device description carries no usable
// base URL, leaving nothing to address the device by.
var errNoDeviceHost = errors.New("device description has no host")

// upnpUnicastSearchTimeout is how long each unicast SSDP search waits for
// responses. It is a variable so tests can shorten it.
var upnpUnicastSearchTimeout = 2 * time.Second

// upnpUnicastSearchTargets are tried in order until one yields a usable gateway.
var upnpUnicastSearchTargets = []upnpSearchTarget{
	searchTargetIGDv2,
	searchTargetIGDv1,
	searchTargetAll,
}

// upnpServiceRank orders WAN connection services by preference, matching the
// existing multicast discovery preference.
var upnpServiceRank = map[string]int{
	internetgateway2.URN_WANIPConnection_2:  3,
	internetgateway2.URN_WANIPConnection_1:  2,
	internetgateway2.URN_WANPPPConnection_1: 1,
}

var _ NAT = (*upnp_NAT)(nil)

func discoverUPNP_IG1(ctx context.Context) <-chan NAT {
	res := make(chan NAT)
	go func() {
		defer close(res)

		// find devices
		devs, err := goupnp.DiscoverDevicesCtx(ctx, internetgateway1.URN_WANConnectionDevice_1)
		if err != nil {
			return
		}

		for _, dev := range devs {
			if dev.Root == nil {
				continue
			}

			dev.Root.Device.VisitServices(func(srv *goupnp.Service) {
				if ctx.Err() != nil {
					return
				}
				switch srv.ServiceType {
				case internetgateway1.URN_WANIPConnection_1:
					client := &internetgateway1.WANIPConnection1{ServiceClient: goupnp.ServiceClient{
						SOAPClient: srv.NewSOAPClient(),
						RootDevice: dev.Root,
						Location:   dev.Location,
						Service:    srv,
					}}
					_, isNat, err := client.GetNATRSIPStatusCtx(ctx)
					if err == nil && isNat {
						select {
						case res <- newUPNPNAT(client, "UPNP (IG1-IP1)", dev.Root):
						case <-ctx.Done():
						}
					}

				case internetgateway1.URN_WANPPPConnection_1:
					client := &internetgateway1.WANPPPConnection1{ServiceClient: goupnp.ServiceClient{
						SOAPClient: srv.NewSOAPClient(),
						RootDevice: dev.Root,
						Location:   dev.Location,
						Service:    srv,
					}}
					_, isNat, err := client.GetNATRSIPStatusCtx(ctx)
					if err == nil && isNat {
						select {
						case res <- newUPNPNAT(client, "UPNP (IG1-PPP1)", dev.Root):
						case <-ctx.Done():
						}
					}

				}
			})
		}

	}()
	return res
}

func discoverUPNP_IG2(ctx context.Context) <-chan NAT {
	res := make(chan NAT)
	go func() {
		defer close(res)

		// find devices
		devs, err := goupnp.DiscoverDevicesCtx(ctx, internetgateway2.URN_WANConnectionDevice_2)
		if err != nil {
			return
		}

		for _, dev := range devs {
			if dev.Root == nil {
				continue
			}

			dev.Root.Device.VisitServices(func(srv *goupnp.Service) {
				if ctx.Err() != nil {
					return
				}
				switch srv.ServiceType {
				case internetgateway2.URN_WANIPConnection_1:
					client := &internetgateway2.WANIPConnection1{ServiceClient: goupnp.ServiceClient{
						SOAPClient: srv.NewSOAPClient(),
						RootDevice: dev.Root,
						Location:   dev.Location,
						Service:    srv,
					}}
					_, isNat, err := client.GetNATRSIPStatusCtx(ctx)
					if err == nil && isNat {
						select {
						case res <- newUPNPNAT(client, "UPNP (IG2-IP1)", dev.Root):
						case <-ctx.Done():
						}
					}

				case internetgateway2.URN_WANIPConnection_2:
					client := &internetgateway2.WANIPConnection2{ServiceClient: goupnp.ServiceClient{
						SOAPClient: srv.NewSOAPClient(),
						RootDevice: dev.Root,
						Location:   dev.Location,
						Service:    srv,
					}}
					_, isNat, err := client.GetNATRSIPStatusCtx(ctx)
					if err == nil && isNat {
						select {
						case res <- newUPNPNAT(client, "UPNP (IG2-IP2)", dev.Root):
						case <-ctx.Done():
						}
					}

				case internetgateway2.URN_WANPPPConnection_1:
					client := &internetgateway2.WANPPPConnection1{ServiceClient: goupnp.ServiceClient{
						SOAPClient: srv.NewSOAPClient(),
						RootDevice: dev.Root,
						Location:   dev.Location,
						Service:    srv,
					}}
					_, isNat, err := client.GetNATRSIPStatusCtx(ctx)
					if err == nil && isNat {
						select {
						case res <- newUPNPNAT(client, "UPNP (IG2-PPP1)", dev.Root):
						case <-ctx.Done():
						}
					}

				}
			})
		}

	}()
	return res
}

func discoverUPNP_Unicast(ctx context.Context) <-chan NAT {
	gateway, err := getDefaultGateway()
	if err != nil {
		return nil
	}
	addr, ok := netip.AddrFromSlice(gateway)
	if !ok {
		return nil
	}
	return discoverUPNPUnicastWithAddr(ctx, netip.AddrPortFrom(addr.Unmap(), ssdpPort))
}

func discoverUPNPUnicastWithAddr(ctx context.Context, gatewayAddr netip.AddrPort) <-chan NAT {
	res := make(chan NAT, 1)
	go func() {
		defer close(res)

		gateway, err := discoverUPNPUnicast(ctx, gatewayAddr)
		if err != nil {
			return
		}

		select {
		case res <- gateway:
		case <-ctx.Done():
		}
	}()
	return res
}

// discoverUPNPUnicast attempts to find a UPnP IGD by sending unicast SSDP
// searches to gatewayAddr. This is useful on networks where multicast SSDP is
// filtered but gateways still answer direct M-SEARCH requests.
func discoverUPNPUnicast(ctx context.Context, gatewayAddr netip.AddrPort) (NAT, error) {
	client, err := httpu.NewHTTPUClient()
	if err != nil {
		return nil, fmt.Errorf("create SSDP client: %w", err)
	}
	defer func() { _ = client.Close() }()

	checked := make(map[string]bool)
	for _, target := range upnpUnicastSearchTargets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		locations, err := searchUPNPUnicast(client, gatewayAddr, target)
		if err != nil {
			continue
		}

		for _, location := range locations {
			if checked[location] {
				continue
			}
			checked[location] = true

			// The search was addressed to the gateway, but any host on the
			// link can answer it. Only follow a description URL that names
			// the gateway itself, so a rogue responder cannot redirect
			// discovery at a device of its choosing.
			if !locationHasAddr(location, gatewayAddr.Addr()) {
				continue
			}

			gateway, err := natFromUPNPLocation(ctx, location, upnpDiscoveryUnicast)
			if err == nil {
				return gateway, nil
			}
		}
	}

	return nil, fmt.Errorf("no UPnP gateway found at %s", gatewayAddr)
}

// locationHasAddr reports whether an SSDP description URL names the device at
// addr. A URL carrying a host name rather than an address is rejected: it
// cannot be checked without resolving it, and a responder free to choose the
// name would then also be choosing what the resolver returns. Gateways
// advertise themselves by address, since a client on the link has no way to
// resolve a name they might publish instead.
func locationHasAddr(location string, addr netip.Addr) bool {
	loc, err := url.Parse(location)
	if err != nil {
		return false
	}
	locAddr, err := netip.ParseAddr(loc.Hostname())
	if err != nil {
		return false
	}
	return locAddr.Unmap() == addr.Unmap()
}

// searchUPNPUnicast sends a unicast M-SEARCH to gatewayAddr and returns the
// description URLs of devices that answered.
func searchUPNPUnicast(client *httpu.HTTPUClient, gatewayAddr netip.AddrPort, searchTarget upnpSearchTarget) ([]string, error) {
	mx := max(int(upnpUnicastSearchTimeout/time.Second), 1)
	host := gatewayAddr.String()
	req := &http.Request{
		Method: "M-SEARCH",
		// httpu sends the request to req.Host, making the search unicast.
		Host: host,
		URL:  &url.URL{Opaque: "*"},
		// Header keys are set verbatim (map literal keys bypass Go's
		// canonicalization) to keep the upper-case field names SSDP
		// implementations expect.
		Header: http.Header{
			"HOST": []string{host},
			"MAN":  []string{`"ssdp:discover"`},
			"MX":   []string{strconv.Itoa(mx)},
			"ST":   []string{string(searchTarget)},
		},
	}

	responses, err := client.Do(req, upnpUnicastSearchTimeout, searchRepeats)
	if err != nil {
		return nil, err
	}

	var locations []string
	for _, resp := range responses {
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
		if resp.StatusCode != http.StatusOK {
			continue
		}
		if location := resp.Header.Get("Location"); location != "" {
			locations = append(locations, location)
		}
	}
	return locations, nil
}

func discoverUPNP_GenIGDev(ctx context.Context) <-chan NAT {
	res := make(chan NAT, 1)
	go func() {
		defer close(res)

		deviceList, err := ssdp.Search(ssdp.All, 5, "")
		if err != nil {
			return
		}

		for _, service := range deviceList {
			if !strings.Contains(service.Type, "InternetGatewayDevice") {
				continue
			}

			gateway, err := natFromUPNPLocation(ctx, service.Location, upnpDiscoveryMulticast)
			if err != nil {
				continue
			}

			select {
			case res <- gateway:
			case <-ctx.Done():
			}
			return
		}
	}()
	return res
}

// natFromUPNPLocation fetches the device description and returns a NAT backed
// by the most preferred WAN connection service it offers.
func natFromUPNPLocation(ctx context.Context, location string, discovery upnpDiscovery) (NAT, error) {
	loc, err := url.Parse(location)
	if err != nil {
		return nil, fmt.Errorf("parse location: %w", err)
	}

	root, err := goupnp.DeviceByURLCtx(ctx, loc)
	if err != nil {
		return nil, fmt.Errorf("fetch device description: %w", err)
	}

	var services []*goupnp.Service
	root.Device.VisitServices(func(srv *goupnp.Service) {
		if upnpServiceRank[srv.ServiceType] > 0 {
			services = append(services, srv)
		}
	})
	sort.SliceStable(services, func(i, j int) bool {
		return upnpServiceRank[services[i].ServiceType] > upnpServiceRank[services[j].ServiceType]
	})

	for _, srv := range services {
		gateway, err := natFromUPNPService(ctx, root, loc, srv, discovery)
		if err == nil {
			return gateway, nil
		}
	}

	return nil, fmt.Errorf("no usable WAN connection service in device at %s", location)
}

// natFromUPNPService builds a NAT from one WAN connection service. discovery
// names how the device was found and ends up in the NAT type.
func natFromUPNPService(ctx context.Context, root *goupnp.RootDevice, loc *url.URL, srv *goupnp.Service, discovery upnpDiscovery) (NAT, error) {
	serviceClient := goupnp.ServiceClient{
		SOAPClient: srv.NewSOAPClient(),
		RootDevice: root,
		Location:   loc,
		Service:    srv,
	}

	var client upnp_NAT_Client
	var service string
	switch srv.ServiceType {
	case internetgateway2.URN_WANIPConnection_2:
		client = &internetgateway2.WANIPConnection2{ServiceClient: serviceClient}
		service = "IP2"
	case internetgateway2.URN_WANIPConnection_1:
		client = &internetgateway2.WANIPConnection1{ServiceClient: serviceClient}
		service = "IP1"
	case internetgateway2.URN_WANPPPConnection_1:
		client = &internetgateway2.WANPPPConnection1{ServiceClient: serviceClient}
		service = "PPP1"
	default:
		return nil, fmt.Errorf("unsupported service type %s", srv.ServiceType)
	}

	_, isNAT, err := client.GetNATRSIPStatusCtx(ctx)
	if err != nil {
		return nil, fmt.Errorf("get NAT status: %w", err)
	}
	if !isNAT {
		return nil, errors.New("gateway reports NAT disabled")
	}

	return newUPNPNAT(client, fmt.Sprintf("UPnP %s (%s)", discovery, service), root), nil
}

type upnp_NAT_Client interface {
	GetExternalIPAddressCtx(context.Context) (string, error)
	AddPortMappingCtx(context.Context, string, uint16, string, uint16, string, bool, string, uint32) error
	DeletePortMappingCtx(context.Context, string, uint16, string) error
	GetNATRSIPStatusCtx(context.Context) (bool, bool, error)
}

// upnpMappingKey identifies one mapping on the device. The protocol is part of
// the key because a device holds independent TCP and UDP mappings for the same
// internal port.
type upnpMappingKey struct {
	protocol string
	port     uint16
}

type upnp_NAT struct {
	c          upnp_NAT_Client
	typ        string
	rootDevice *goupnp.RootDevice

	// mu is held across the device call and the cache update together, so that
	// two callers cannot both miss the cache and create competing mappings, or
	// drop a cache entry while the other is still installing it. A UPnP device
	// answers one SOAP request at a time anyway.
	mu    sync.Mutex
	ports map[upnpMappingKey]uint16
}

func newUPNPNAT(client upnp_NAT_Client, typ string, root *goupnp.RootDevice) *upnp_NAT {
	return &upnp_NAT{
		c:          client,
		typ:        typ,
		rootDevice: root,
		ports:      make(map[upnpMappingKey]uint16),
	}
}

func (u *upnp_NAT) GetExternalAddress() (addr net.IP, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), deviceTimeout)
	defer cancel()

	ipString, err := u.c.GetExternalIPAddressCtx(ctx)
	if err != nil {
		return nil, err
	}

	ip := net.ParseIP(ipString)
	if ip == nil {
		return nil, ErrNoExternalAddress
	}

	return ip, nil
}

func mapProtocol(s string) (string, error) {
	switch s {
	case "udp":
		return "UDP", nil
	case "tcp":
		return "TCP", nil
	default:
		return "", fmt.Errorf("invalid protocol: %s", s)
	}
}

func (u *upnp_NAT) AddPortMapping(ctx context.Context, protocol string, internalPort int, description string, timeout time.Duration) (int, error) {
	proto, err := mapProtocol(protocol)
	if err != nil {
		return 0, err
	}

	ip, err := u.internalAddress(ctx)
	if err != nil {
		return 0, fmt.Errorf("get internal address: %w", err)
	}

	timeoutInSeconds := uint32(timeout / time.Second)
	key := upnpMappingKey{protocol: proto, port: uint16(internalPort)}

	u.mu.Lock()
	defer u.mu.Unlock()

	if externalPort := u.ports[key]; externalPort > 0 {
		err = u.c.AddPortMappingCtx(ctx, "", externalPort, proto, key.port, ip.String(), true, description, timeoutInSeconds)
		if err == nil {
			return int(externalPort), nil
		}
	}

	for range 3 {
		externalPort := uint16(randomPort())
		err = u.c.AddPortMappingCtx(ctx, "", externalPort, proto, key.port, ip.String(), true, description, timeoutInSeconds)
		if err == nil {
			u.ports[key] = externalPort
			return int(externalPort), nil
		}
	}

	return 0, err
}

func (u *upnp_NAT) DeletePortMapping(ctx context.Context, protocol string, internalPort int) error {
	proto, err := mapProtocol(protocol)
	if err != nil {
		return err
	}

	key := upnpMappingKey{protocol: proto, port: uint16(internalPort)}

	u.mu.Lock()
	defer u.mu.Unlock()

	externalPort, ok := u.ports[key]
	if !ok {
		return nil
	}

	if err := u.c.DeletePortMappingCtx(ctx, "", externalPort, proto); err != nil {
		return err
	}
	// Drop the entry only once the device confirms, so a failed delete leaves
	// the mapping addressable for a retry instead of orphaning it.
	delete(u.ports, key)
	return nil
}

func (u *upnp_NAT) GetDeviceAddress() (net.IP, error) {
	host, err := deviceHostPort(u.rootDevice)
	if err != nil {
		return nil, err
	}

	addr, err := net.ResolveUDPAddr("udp", host)
	if err != nil {
		return nil, err
	}

	return addr.IP, nil
}

// GetInternalAddress returns the local address the gateway sees us on. The NAT
// interface takes no context here, so it applies its own timeout; callers that
// have one reach internalAddress directly.
func (u *upnp_NAT) GetInternalAddress() (net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), deviceTimeout)
	defer cancel()
	return u.internalAddress(ctx)
}

// internalAddress asks the routing table which source address would be used to
// reach the device, which picks the right one when several interfaces share a
// subnet with it.
func (u *upnp_NAT) internalAddress(ctx context.Context) (net.IP, error) {
	host, err := deviceHostPort(u.rootDevice)
	if err != nil {
		return nil, err
	}

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "udp", host)
	if err != nil {
		return nil, fmt.Errorf("resolve local address for %s: %w", host, err)
	}
	defer func() { _ = conn.Close() }()

	localAddr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil, ErrNoInternalAddress
	}
	return localAddr.IP, nil
}

// deviceHostPort returns the device's host:port, supplying the HTTP default
// port when the device's URLBase omits it, as the UPnP Device Architecture
// allows it to.
func deviceHostPort(root *goupnp.RootDevice) (string, error) {
	// Hostname and Port handle the brackets around an IPv6 literal, which
	// splitting URLBase.Host by hand would not.
	host := root.URLBase.Hostname()
	if host == "" {
		return "", errNoDeviceHost
	}
	port := root.URLBase.Port()
	if port == "" {
		port = defaultHTTPPort
	}
	return net.JoinHostPort(host, port), nil
}

func (n *upnp_NAT) Type() string { return n.typ }
