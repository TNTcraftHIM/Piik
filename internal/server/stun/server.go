// Package stun owns the UDP listeners for in-process STUN discovery.
package stun

import (
	"context"
	"errors"
	"io"
	"net"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

type Server struct {
	*turn.Server
	Addresses []net.Addr
}

// Listen binds the ordinary endpoint or the three-destination NAT survey.
// The caller closes the returned server with the application lifecycle.
func Listen(ctx context.Context, addresses []string) (*Server, error) {
	if len(addresses) != 1 && len(addresses) != 3 {
		return nil, errors.New("STUN requires one or three UDP listeners")
	}
	var listeners []turn.PacketConnConfig
	var bound []net.Addr
	closeListeners := func() {
		for _, listener := range listeners {
			_ = listener.PacketConn.Close()
		}
	}
	for _, address := range addresses {
		connection, err := (&net.ListenConfig{}).ListenPacket(ctx, "udp4", address)
		if err != nil {
			closeListeners()
			return nil, err
		}
		listeners = append(listeners, turn.PacketConnConfig{PacketConn: connection})
		bound = append(bound, connection.LocalAddr())
	}
	logger := logging.NewDefaultLoggerFactory()
	// Library packet logs include remote addresses; do not export them.
	logger.Writer = io.Discard
	server, err := turn.NewServer(turn.ServerConfig{
		PacketConnConfigs: listeners,
		LoggerFactory:     logger,
		// No AuthHandler or relay generator: Pion's STUN-only mode.
	})
	if err != nil {
		closeListeners()
		return nil, err
	}
	return &Server{Server: server, Addresses: bound}, nil
}
