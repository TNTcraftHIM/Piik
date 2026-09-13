package pcp

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"
)

const (
	defaultTimeout     = 3 * time.Second
	responseBufferSize = 128

	// RFC 6887 Section 8.1.1 retry timing.
	initialRetryDelay = 3 * time.Second
	maxRetryDelay     = 1024 * time.Second
	maxRetries        = 4
)

// Client is a PCP protocol client.
// All methods are safe for concurrent use.
type Client struct {
	gateway netip.Addr
	timeout time.Duration

	mu sync.Mutex
	// localIP caches the resolved local IP address.
	localIP netip.Addr
	// lastEpoch is the last observed server epoch value.
	lastEpoch uint32
	// epochTime tracks when lastEpoch was received for state loss detection.
	epochTime time.Time
	// externalIP caches the external IP from the last successful MAP response.
	externalIP netip.Addr
	// epochStateLost is set when epoch indicates server restart.
	epochStateLost bool
	// nonces holds the nonce for each active mapping; RFC 6887 requires
	// renewals and deletes to reuse the nonce the mapping was created with.
	nonces map[mappingKey][12]byte
	// mappingLocks serializes requests per mapping. The nonce is the server's
	// identity for a mapping, so a delete completing while a create for the
	// same key is still in flight would drop the nonce the created mapping
	// needs, leaving one on the server that no later delete can remove.
	mappingLocks map[mappingKey]*sync.Mutex
}

// lockMapping serializes requests for one mapping. It never holds c.mu across
// the request itself, which would block every other operation on the client for
// the length of a UDP exchange.
func (c *Client) lockMapping(key mappingKey) func() {
	c.mu.Lock()
	lock, ok := c.mappingLocks[key]
	if !ok {
		lock = &sync.Mutex{}
		if c.mappingLocks == nil {
			c.mappingLocks = make(map[mappingKey]*sync.Mutex)
		}
		c.mappingLocks[key] = lock
	}
	c.mu.Unlock()

	lock.Lock()
	return lock.Unlock
}

type mappingKey struct {
	proto uint8
	port  uint16
}

// NewClient creates a new PCP client for the gateway at the given IP.
func NewClient(gateway net.IP) *Client {
	return NewClientWithTimeout(gateway, defaultTimeout)
}

// NewClientWithTimeout creates a new PCP client with a custom timeout.
func NewClientWithTimeout(gateway net.IP, timeout time.Duration) *Client {
	addr, ok := netip.AddrFromSlice(gateway)
	if !ok {
		return &Client{timeout: timeout}
	}
	return &Client{
		gateway: addr.Unmap(),
		timeout: timeout,
	}
}

// SetLocalIP sets the local IP address to use in PCP requests.
func (c *Client) SetLocalIP(ip net.IP) {
	addr, ok := netip.AddrFromSlice(ip)

	c.mu.Lock()
	defer c.mu.Unlock()
	if !ok {
		c.localIP = netip.Addr{}
		return
	}
	c.localIP = addr.Unmap()
}

// Gateway returns the gateway IP address.
func (c *Client) Gateway() net.IP {
	if !c.gateway.IsValid() {
		return nil
	}
	return append(net.IP(nil), c.gateway.AsSlice()...)
}

// Announce sends a PCP ANNOUNCE request to discover PCP support.
// It returns the server's epoch time on success.
func (c *Client) Announce(ctx context.Context) (epoch uint32, err error) {
	localIP, err := c.getLocalIP()
	if err != nil {
		return 0, fmt.Errorf("get local IP: %w", err)
	}

	req := buildAnnounceRequest(localIP)
	resp, err := c.sendRequest(ctx, req)
	if err != nil {
		return 0, fmt.Errorf("send announce: %w", err)
	}

	parsed, err := parseResponse(resp)
	if err != nil {
		return 0, fmt.Errorf("parse announce response: %w", err)
	}

	if parsed.ResultCode != ResultSuccess {
		return 0, fmt.Errorf("PCP ANNOUNCE failed: %s", ResultCodeString(parsed.ResultCode))
	}

	c.mu.Lock()
	c.updateEpochLocked(parsed.Epoch)
	c.mu.Unlock()
	return parsed.Epoch, nil
}

// AddPortMapping requests a port mapping from the PCP server.
func (c *Client) AddPortMapping(ctx context.Context, protocol string, internalPort int, lifetime time.Duration) (*MapResponse, error) {
	return c.addPortMappingWithHint(ctx, protocol, internalPort, internalPort, netip.Addr{}, lifetime)
}

// AddPortMappingWithHint requests a port mapping with suggested external port and IP.
// Use lifetime <= 0 to delete a mapping.
func (c *Client) AddPortMappingWithHint(ctx context.Context, protocol string, internalPort, suggestedExtPort int, suggestedExtIP net.IP, lifetime time.Duration) (*MapResponse, error) {
	var extIP netip.Addr
	if suggestedExtIP != nil {
		var ok bool
		extIP, ok = netip.AddrFromSlice(suggestedExtIP)
		if ok {
			extIP = extIP.Unmap()
		}
	}
	return c.addPortMappingWithHint(ctx, protocol, internalPort, suggestedExtPort, extIP, lifetime)
}

func (c *Client) addPortMappingWithHint(ctx context.Context, protocol string, internalPort, suggestedExtPort int, suggestedExtIP netip.Addr, lifetime time.Duration) (*MapResponse, error) {
	if internalPort <= 0 || internalPort > 65535 {
		return nil, fmt.Errorf("invalid internal port: %d", internalPort)
	}
	if suggestedExtPort < 0 || suggestedExtPort > 65535 {
		return nil, fmt.Errorf("invalid suggested external port: %d", suggestedExtPort)
	}

	localIP, err := c.getLocalIP()
	if err != nil {
		return nil, fmt.Errorf("get local IP: %w", err)
	}

	proto, err := protocolNumber(protocol)
	if err != nil {
		return nil, fmt.Errorf("parse protocol: %w", err)
	}

	// Convert lifetime to seconds. Lifetime 0 means delete, so only apply the
	// default for positive durations that round to 0 seconds.
	var lifetimeSec uint32
	if lifetime > 0 {
		lifetimeSec = uint32(lifetime.Seconds())
		if lifetimeSec == 0 {
			lifetimeSec = DefaultLifetime
		}
	}

	// Generate a candidate before taking the lock, which also guards the epoch
	// and the cached external IP: an entropy read should not block them.
	var fresh [12]byte
	if _, err := rand.Read(fresh[:]); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	key := mappingKey{proto: proto, port: uint16(internalPort)}
	defer c.lockMapping(key)()

	c.mu.Lock()
	nonce, haveNonce := c.nonces[key]
	if !haveNonce {
		nonce = fresh
	}
	// Store the nonce before sending: if the server creates the mapping but
	// the response is lost, a later delete must still present this nonce or
	// the server answers NOT_AUTHORIZED and the mapping leaks (RFC 6887 §11.3).
	if lifetimeSec > 0 {
		if c.nonces == nil {
			c.nonces = make(map[mappingKey][12]byte)
		}
		c.nonces[key] = nonce
	}
	c.mu.Unlock()

	req := buildMapRequest(localIP, nonce, proto, uint16(internalPort), uint16(suggestedExtPort), suggestedExtIP, lifetimeSec)

	resp, err := c.sendRequest(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("send map request: %w", err)
	}

	mapResp, err := parseMapResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("parse map response: %w", err)
	}

	if mapResp.Nonce != nonce {
		return nil, errors.New("nonce mismatch in response")
	}
	if mapResp.Protocol != proto {
		return nil, fmt.Errorf("protocol mismatch: requested %d, got %d", proto, mapResp.Protocol)
	}
	if mapResp.InternalPort != uint16(internalPort) {
		return nil, fmt.Errorf("internal port mismatch: requested %d, got %d", internalPort, mapResp.InternalPort)
	}
	if mapResp.ResultCode != ResultSuccess {
		return nil, &Error{
			Code:    mapResp.ResultCode,
			Message: ResultCodeString(mapResp.ResultCode),
		}
	}

	c.mu.Lock()
	c.updateEpochLocked(mapResp.Epoch)
	c.cacheExternalIPLocked(mapResp.ExternalIP)
	if lifetimeSec == 0 {
		delete(c.nonces, key)
	}
	c.mu.Unlock()
	return mapResp, nil
}

// DeletePortMapping removes a port mapping by requesting zero lifetime.
// Deleting a nonexistent mapping succeeds (RFC 6887 §15.1), so any error is
// a real failure and is returned.
//
// This only deletes mappings that this Client created. RFC 6887 §11.3 matches a
// MAP request to an existing mapping by nonce, and the nonces live in memory,
// so a mapping created by an earlier process cannot be deleted: the server sees
// an unknown nonce and treats the request as a no-op on a mapping that does not
// exist. Such a mapping expires on its own once its lifetime runs out. A caller
// that needs to clean up after a crash has to persist the nonce alongside the
// port and restore it before calling this.
func (c *Client) DeletePortMapping(ctx context.Context, protocol string, internalPort int) error {
	if _, err := c.addPortMappingWithHint(ctx, protocol, internalPort, 0, netip.Addr{}, 0); err != nil {
		return fmt.Errorf("delete mapping: %w", err)
	}
	return nil
}

// GetExternalAddress returns the external IP address.
// It first checks for a cached value from previous MAP responses. If not
// cached, it creates a short-lived mapping to discover the external IP.
func (c *Client) GetExternalAddress(ctx context.Context) (net.IP, error) {
	c.mu.Lock()
	if c.externalIP.IsValid() {
		ip := append(net.IP(nil), c.externalIP.AsSlice()...)
		c.mu.Unlock()
		return ip, nil
	}
	c.mu.Unlock()

	// Use an ephemeral port in the dynamic range (49152-65535). Port 0 is not
	// valid with UDP/TCP protocols per RFC 6887.
	ephemeralPort := 49152 + int(uint16(time.Now().UnixNano()))%(65535-49152)

	// Use minimal lifetime (1 second) for discovery.
	resp, err := c.AddPortMapping(ctx, "udp", ephemeralPort, time.Second)
	if err != nil {
		return nil, fmt.Errorf("create temporary mapping: %w", err)
	}

	_ = c.DeletePortMapping(ctx, "udp", ephemeralPort)

	return append(net.IP(nil), resp.ExternalIP.AsSlice()...), nil
}

// LastEpoch returns the last observed server epoch value.
// A decrease in epoch indicates the server may have restarted and mappings may be lost.
func (c *Client) LastEpoch() uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastEpoch
}

// EpochStateLost returns true if epoch state loss was detected and clears the flag.
func (c *Client) EpochStateLost() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	lost := c.epochStateLost
	c.epochStateLost = false
	return lost
}

// updateEpochLocked updates epoch tracking and detects potential state loss.
// It returns true if state loss was detected. Caller must hold c.mu.
func (c *Client) updateEpochLocked(newEpoch uint32) bool {
	now := time.Now()
	stateLost := false

	// RFC 6887 Section 8.5: Detect invalid epoch indicating server state loss.
	// client_delta = time since last response
	// server_delta = epoch change since last response
	// Invalid if: client_delta+2 < server_delta - server_delta/16
	//         OR: server_delta+2 < client_delta - client_delta/16
	// The +2 handles quantization, /16 (6.25%) handles clock drift.
	if !c.epochTime.IsZero() && c.lastEpoch > 0 {
		clientDelta := uint32(now.Sub(c.epochTime).Seconds())
		serverDelta := newEpoch - c.lastEpoch

		// Check for epoch going backwards or jumping unexpectedly. Subtraction is
		// safe: serverDelta/16 is always <= serverDelta.
		if clientDelta+2 < serverDelta-(serverDelta/16) ||
			serverDelta+2 < clientDelta-(clientDelta/16) {
			stateLost = true
			c.epochStateLost = true
		}
	}

	c.lastEpoch = newEpoch
	c.epochTime = now
	return stateLost
}

// cacheExternalIPLocked stores the external IP from a successful MAP response.
// Caller must hold c.mu.
func (c *Client) cacheExternalIPLocked(ip netip.Addr) {
	if ip.IsValid() && !ip.IsUnspecified() {
		c.externalIP = ip
	}
}

// sendRequest sends a PCP request with retries per RFC 6887 Section 8.1.1.
func (c *Client) sendRequest(ctx context.Context, req []byte) ([]byte, error) {
	if !c.gateway.IsValid() {
		return nil, errors.New("gateway IP not set")
	}

	addr := &net.UDPAddr{IP: c.gateway.AsSlice(), Port: Port, Zone: c.gateway.Zone()}

	var lastErr error
	delay := initialRetryDelay

	for attempt := 0; attempt < maxRetries; attempt++ {
		resp, err := c.sendOnce(ctx, addr, req)
		if err == nil {
			return resp, nil
		}
		lastErr = err

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if attempt == maxRetries-1 {
			break
		}

		// RFC 6887 Section 8.1.1: RT = (1 + RAND) * MIN(2 * RTprev, MRT),
		// where RAND is random between -0.1 and +0.1.
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(retryDelayWithJitter(delay)):
		}
		delay = min(delay*2, maxRetryDelay)
	}

	return nil, fmt.Errorf("PCP request failed after %d retries: %w", maxRetries, lastErr)
}

// retryDelayWithJitter applies RFC 6887 jitter: multiply by (1 + RAND) where RAND is [-0.1, +0.1].
func retryDelayWithJitter(d time.Duration) time.Duration {
	var b [1]byte
	_, _ = rand.Read(b[:])
	// Convert byte to range [-0.1, +0.1]: (b/255 * 0.2) - 0.1.
	jitter := (float64(b[0])/255.0)*0.2 - 0.1
	return time.Duration(float64(d) * (1 + jitter))
}

func (c *Client) sendOnce(ctx context.Context, addr *net.UDPAddr, req []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Use ListenUDP instead of DialUDP to validate response source address per RFC 6887 §8.3.
	conn, err := net.ListenUDP("udp", nil)
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	defer func() { _ = conn.Close() }()

	timeout := c.timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, ctx.Err()
		}
		if remaining < timeout {
			timeout = remaining
		}
	}

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return nil, fmt.Errorf("set deadline: %w", err)
	}
	stopCancel := context.AfterFunc(ctx, func() {
		_ = conn.SetDeadline(time.Now())
	})
	defer stopCancel()

	if _, err := conn.WriteToUDP(req, addr); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	resp := make([]byte, responseBufferSize)
	n, from, err := conn.ReadFromUDP(resp)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("read: %w", err)
	}

	// RFC 6887 §8.3: Validate response came from expected PCP server.
	if !from.IP.Equal(addr.IP) {
		return nil, fmt.Errorf("response from unexpected source %s (expected %s)", from.IP, addr.IP)
	}

	return resp[:n], nil
}

func (c *Client) getLocalIP() (netip.Addr, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.localIP.IsValid() {
		return netip.Addr{}, fmt.Errorf("local IP not set for gateway %s", c.gateway)
	}
	return c.localIP, nil
}

func protocolNumber(protocol string) (uint8, error) {
	switch protocol {
	case "udp", "UDP":
		return ProtoUDP, nil
	case "tcp", "TCP":
		return ProtoTCP, nil
	default:
		return 0, fmt.Errorf("unsupported protocol: %s", protocol)
	}
}

// Error represents a PCP error response.
type Error struct {
	Code    uint8
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("PCP error: %s (%d)", e.Message, e.Code)
}
