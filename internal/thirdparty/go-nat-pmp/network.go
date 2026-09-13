// Modified by Piik: stop socket I/O and retransmissions on context cancellation.
package natpmp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

const nAT_PMP_PORT = 5351
const nAT_TRIES = 9
const nAT_INITIAL_MS = 250

// A caller that implements the NAT-PMP RPC protocol.
type network struct {
	gateway net.IP
}

func (n *network) call(ctx context.Context, msg []byte, timeout time.Duration) (result []byte, err error) {
	if err = ctx.Err(); err != nil {
		return
	}
	var server net.UDPAddr
	server.IP = n.gateway
	server.Port = nAT_PMP_PORT
	conn, err := net.DialUDP("udp", nil, &server)
	if err != nil {
		return
	}
	defer conn.Close()
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = ctx.Err()
		}
	}()

	// 16 bytes is the maximum result size.
	result = make([]byte, 16)

	var finalTimeout time.Time
	if timeout != 0 {
		finalTimeout = time.Now().Add(timeout)
	}
	if deadline, ok := ctx.Deadline(); ok {
		finalTimeout = minTime(finalTimeout, deadline)
	}

	needNewDeadline := true

	var tries uint
	for tries = 0; (tries < nAT_TRIES && finalTimeout.IsZero()) || time.Now().Before(finalTimeout); {
		if err = ctx.Err(); err != nil {
			return
		}
		if needNewDeadline {
			nextDeadline := time.Now().Add((nAT_INITIAL_MS << tries) * time.Millisecond)
			err = conn.SetDeadline(minTime(nextDeadline, finalTimeout))
			if err != nil {
				return
			}
			needNewDeadline = false
		}
		_, err = conn.Write(msg)
		if err != nil {
			return
		}
		var bytesRead int
		var remoteAddr *net.UDPAddr
		bytesRead, remoteAddr, err = conn.ReadFromUDP(result)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				tries++
				needNewDeadline = true
				continue
			}
			return
		}
		if !remoteAddr.IP.Equal(n.gateway) {
			// Ignore this packet.
			// Continue without increasing retransmission timeout or deadline.
			continue
		}
		// Trim result to actual number of bytes received
		if bytesRead < len(result) {
			result = result[:bytesRead]
		}
		return
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return nil, context.DeadlineExceeded
	}
	err = fmt.Errorf("Timed out trying to contact gateway")
	return
}

func minTime(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	if b.IsZero() {
		return a
	}
	if a.Before(b) {
		return a
	}
	return b
}
