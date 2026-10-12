// This laboratory-only external STUN endpoint uses the same mature Binding
// implementation as Piik. It supplies IPv6 discovery without changing product
// configuration or disabling the browser's mDNS privacy behavior.
package main

import (
	"fmt"
	"io"
	"net"
	"os"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("expected one IPv6 listen address")
	}
	connection, err := net.ListenPacket("udp6", os.Args[1])
	if err != nil {
		return err
	}
	defer connection.Close()
	logger := logging.NewDefaultLoggerFactory()
	logger.Writer = io.Discard
	server, err := turn.NewServer(turn.ServerConfig{
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: connection}},
		LoggerFactory:     logger,
	})
	if err != nil {
		return err
	}
	defer server.Close()
	fmt.Println(`{"ready":true}`)
	_, err = io.Copy(io.Discard, os.Stdin)
	return err
}
