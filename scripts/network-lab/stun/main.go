// This laboratory-only external STUN endpoint uses the same mature Binding
// implementation as Piik. It keeps ordinary discovery available in prediction
// on/off and IPv6 trials without adding product configuration.
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
	if len(os.Args) < 2 {
		return fmt.Errorf("expected STUN listen addresses")
	}
	var connections []turn.PacketConnConfig
	for _, address := range os.Args[1:] {
		connection, err := net.ListenPacket("udp", address)
		if err != nil {
			return err
		}
		defer connection.Close()
		connections = append(connections, turn.PacketConnConfig{PacketConn: connection})
	}
	logger := logging.NewDefaultLoggerFactory()
	logger.Writer = io.Discard
	server, err := turn.NewServer(turn.ServerConfig{
		PacketConnConfigs: connections,
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
